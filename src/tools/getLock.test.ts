import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicClient } from "viem";
import { zeroAddress } from "viem";
import type { NetworkConfig } from "../networks.js";
import { classifyLock, UNLIMITED } from "./shared.js";
import { formatGetLockResult, resolveLockDetails } from "./getLock.js";

const LOCK = "0x1111111111111111111111111111111111111a" as const;
const ERC20_TOKEN = "0x3333333333333333333333333333333333333c" as const;
const VERSION = 14;
const NAME = "Test Lock";

const NETWORK: NetworkConfig = {
  id: 8453,
  name: "Base",
  rpcUrls: ["https://example.invalid/rpc"],
  unlockAddress: "0x0000000000000000000000000000000000dEaD",
  subgraph: "https://example.invalid/subgraph",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
};

type Overrides = Record<string, unknown>;

function mockClient(overrides: Overrides): Pick<PublicClient, "readContract"> {
  return {
    readContract: (async ({ functionName }: { functionName: string }) => {
      if (functionName in overrides) return overrides[functionName];
      throw new Error(`unexpected functionName in mock: ${functionName}`);
    }) as PublicClient["readContract"],
  };
}

test("classifyLock reports not_a_contract when there is no bytecode", async () => {
  const client: Pick<PublicClient, "getCode" | "readContract"> = {
    getCode: (async () => "0x") as PublicClient["getCode"],
    readContract: (async () => {
      throw new Error("should not be called");
    }) as PublicClient["readContract"],
  };

  const result = await classifyLock(client, LOCK, NETWORK);
  assert.deepEqual(result, { status: "not_a_contract" });
});

test("resolveLockDetails reports a free, native-currency, unlimited-duration lock", async () => {
  const client = mockClient({
    symbol: "KEY",
    keyPrice: 0n,
    tokenAddress: zeroAddress,
    expirationDuration: UNLIMITED,
    maxNumberOfKeys: UNLIMITED,
    totalSupply: 1n,
  });

  const result = await resolveLockDetails(client, LOCK, VERSION, NAME, NETWORK);

  assert.equal(result.status, "ok");
  assert.equal(result.keyPrice?.currency, "native");
  assert.equal(result.keyPrice?.amount, "0");
  assert.equal(result.keyPrice?.tokenSymbol, "ETH");
  assert.deepEqual(result.expirationDuration, { unlimited: true });
  assert.deepEqual(result.maxNumberOfKeys, { unlimited: true });
  assert.equal(result.totalKeysSold, "1");
});

test("resolveLockDetails reports a fixed 1-day duration in human-readable form", async () => {
  const client = mockClient({
    symbol: "KEY",
    keyPrice: 0n,
    tokenAddress: zeroAddress,
    expirationDuration: 86_400n,
    maxNumberOfKeys: 100n,
    totalSupply: 1n,
  });

  const result = await resolveLockDetails(client, LOCK, VERSION, NAME, NETWORK);

  assert.deepEqual(result.expirationDuration, { unlimited: false, seconds: "86400", humanReadable: "1 day" });
  assert.deepEqual(result.maxNumberOfKeys, { unlimited: false, value: "100" });
});

test("resolveLockDetails resolves ERC-20 symbol and decimals, and formats the price with them", async () => {
  const client = mockClient({
    symbol: "KEY",
    keyPrice: 1_000_000n,
    tokenAddress: ERC20_TOKEN,
    expirationDuration: 2_592_000n,
    maxNumberOfKeys: 50n,
    totalSupply: 3n,
    decimals: 6,
    // erc20Abi and publicLockAbi both declare a "symbol" function; the mock keys on
    // functionName alone, so the lock's own "KEY" symbol above would collide with the
    // token's. readContract is called with different `address`es though, so route by
    // that via a second mock instead.
  });
  const erc20Client: Pick<PublicClient, "readContract"> = {
    readContract: (async ({ address, functionName }: { address: string; functionName: string }) => {
      if (address === ERC20_TOKEN) {
        if (functionName === "symbol") return "USDC";
        if (functionName === "decimals") return 6;
      }
      return client.readContract({ functionName } as never);
    }) as PublicClient["readContract"],
  };

  const result = await resolveLockDetails(erc20Client, LOCK, VERSION, NAME, NETWORK);

  assert.equal(result.keyPrice?.currency, "erc20");
  assert.equal(result.keyPrice?.tokenSymbol, "USDC");
  assert.equal(result.keyPrice?.tokenDecimals, 6);
  assert.equal(result.keyPrice?.amount, "1");
  assert.equal(result.keyPrice?.raw, "1000000");
});

test("formatGetLockResult reports unlimited duration and free price in plain language", async () => {
  const client = mockClient({
    symbol: "KEY",
    keyPrice: 0n,
    tokenAddress: zeroAddress,
    expirationDuration: UNLIMITED,
    maxNumberOfKeys: UNLIMITED,
    totalSupply: 1n,
  });
  const result = await resolveLockDetails(client, LOCK, VERSION, NAME, NETWORK);

  const text = formatGetLockResult(result);
  assert.match(text, /free/);
  assert.match(text, /unlimited \(keys never expire\)/);
  assert.match(text, /Max number of keys: unlimited/);
});

test("formatGetLockResult reports not_a_contract and not_a_lock plainly", () => {
  const notAContract = formatGetLockResult({
    status: "not_a_contract",
    network: "Base",
    lockAddress: LOCK,
  });
  assert.match(notAContract, /Not a contract/);

  const notALock = formatGetLockResult({
    status: "not_a_lock",
    network: "Base",
    lockAddress: LOCK,
  });
  assert.match(notALock, /Not a lock/);
});
