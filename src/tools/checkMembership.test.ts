import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AbiDecodingZeroDataError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  type PublicClient,
} from "viem";
import { publicLockAbi } from "../abi/publicLock.js";
import type { NetworkConfig } from "../networks.js";
import { MembershipCheckError, resolveBestKey, resolveMembershipStatus } from "./checkMembership.js";

// What viem actually throws when a call returns "0x" and there's nothing to decode —
// e.g. a non-reverting fallback, or an address that just doesn't implement the
// function. Distinct from a revert: ContractFunctionRevertedError never appears in
// this chain, only ContractFunctionZeroDataError / AbiDecodingZeroDataError.
function zeroDataError(functionName: string, args: readonly unknown[] = []): ContractFunctionExecutionError {
  const zeroData = new ContractFunctionZeroDataError({
    functionName,
    cause: new AbiDecodingZeroDataError(),
  });
  return new ContractFunctionExecutionError(zeroData, { abi: publicLockAbi, functionName, args });
}

const LOCK = "0x1111111111111111111111111111111111111a" as const;
const WALLET = "0x2222222222222222222222222222222222222b" as const;
const VERSION = 14; // v10+, so keyExpirationTimestampFor takes a tokenId

const NETWORK: NetworkConfig = {
  id: 8453,
  name: "Base",
  rpcUrls: ["https://example.invalid/rpc"],
  unlockAddress: "0x0000000000000000000000000000000000dEaD",
  subgraph: "https://example.invalid/subgraph",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
};

function mockClient(calls: { functionName: string; args: readonly unknown[] }[]): Pick<PublicClient, "readContract"> {
  return {
    readContract: (async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      calls.push({ functionName, args });
      if (functionName === "tokenOfOwnerByIndex") return 42n;
      if (functionName === "keyExpirationTimestampFor") return 1_900_000_000n;
      throw new Error(`unexpected functionName in mock: ${functionName}`);
    }) as PublicClient["readContract"],
  };
}

test("pre-v10 locks (version 9) call keyExpirationTimestampFor with the owner address", async () => {
  const calls: { functionName: string; args: readonly unknown[] }[] = [];
  const client = mockClient(calls);

  await resolveBestKey(client, LOCK, WALLET, 1n, 9);

  const expirationCall = calls.find((c) => c.functionName === "keyExpirationTimestampFor");
  assert.ok(expirationCall, "keyExpirationTimestampFor was not called");
  assert.deepEqual(expirationCall.args, [WALLET]);
});

test("pre-v10 locks (version 9) read keyExpirationTimestampFor exactly once, regardless of tokenId count", async () => {
  const calls: { functionName: string; args: readonly unknown[] }[] = [];
  const client = mockClient(calls);

  await resolveBestKey(client, LOCK, WALLET, 3n, 9);

  const expirationCalls = calls.filter((c) => c.functionName === "keyExpirationTimestampFor");
  assert.equal(
    expirationCalls.length,
    1,
    "pre-v10 locks expose one expiration per wallet, not per tokenId — reading more than once is redundant"
  );
});

test("v10+ locks (version 14) call keyExpirationTimestampFor with the tokenId", async () => {
  const calls: { functionName: string; args: readonly unknown[] }[] = [];
  const client = mockClient(calls);

  await resolveBestKey(client, LOCK, WALLET, 1n, 14);

  const expirationCall = calls.find((c) => c.functionName === "keyExpirationTimestampFor");
  assert.ok(expirationCall, "keyExpirationTimestampFor was not called");
  assert.deepEqual(expirationCall.args, [42n]);
});

// Mocks totalKeys, tokenOfOwnerByIndex, keyExpirationTimestampFor, and
// getHasValidKey for a single key (tokenId 7) so resolveMembershipStatus can be
// driven end-to-end without a network call.
//
// hasValidKey controls what getHasValidKey answers: a boolean returns it directly
// (so callers can force agreement or disagreement with the expiration comparison);
// an Error makes the mocked call throw it (e.g. to simulate the revert a lock
// without getHasValidKey would produce); omitted, it defaults to whatever the local
// expiration comparison would conclude, so tests that don't care about this new
// behavior see the same result as before it existed.
function mockStatusClient(
  totalKeys: bigint,
  expiration: bigint,
  hasValidKey?: boolean | Error
): { client: Pick<PublicClient, "readContract">; calls: { functionName: string; args: readonly unknown[] }[] } {
  const calls: { functionName: string; args: readonly unknown[] }[] = [];
  const client: Pick<PublicClient, "readContract"> = {
    readContract: (async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      calls.push({ functionName, args });
      if (functionName === "totalKeys") return totalKeys;
      if (functionName === "tokenOfOwnerByIndex") return 7n;
      if (functionName === "keyExpirationTimestampFor") return expiration;
      if (functionName === "getHasValidKey") {
        if (hasValidKey instanceof Error) throw hasValidKey;
        return hasValidKey ?? expiration > BigInt(Math.floor(Date.now() / 1000));
      }
      throw new Error(`unexpected functionName in mock: ${functionName}`);
    }) as PublicClient["readContract"],
  };
  return { client, calls };
}

test("totalKeys 0 reports no_key without ever enumerating tokens", async () => {
  const { client, calls } = mockStatusClient(0n, 0n);

  const result = await resolveMembershipStatus(client, LOCK, WALLET, VERSION, "Test Lock", NETWORK);

  assert.equal(result.status, "no_key");
  assert.ok(
    !calls.some((c) => c.functionName === "tokenOfOwnerByIndex"),
    "tokenOfOwnerByIndex should not be called when totalKeys is 0"
  );
});

// Regression for the balanceOf-on-v10+ bug: balanceOf only counts currently-valid
// keys, so a wallet with one expired key and totalKeys === 1 used to read exactly
// like a wallet with no key at all and report no_key. Nothing else covers this path.
test("totalKeys 1 with a past expiration reports expired, with the tokenId and expiration surfaced", async () => {
  const pastExpiration = BigInt(Math.floor(Date.now() / 1000) - 3600);
  const { client } = mockStatusClient(1n, pastExpiration);

  const result = await resolveMembershipStatus(client, LOCK, WALLET, VERSION, "Test Lock", NETWORK);

  assert.equal(result.status, "expired");
  assert.equal(result.tokenId, "7");
  assert.equal(result.expiresAt, new Date(Number(pastExpiration) * 1000).toISOString());
});

test("totalKeys 1 with a future expiration reports valid", async () => {
  const futureExpiration = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const { client } = mockStatusClient(1n, futureExpiration);

  const result = await resolveMembershipStatus(client, LOCK, WALLET, VERSION, "Test Lock", NETWORK);

  assert.equal(result.status, "valid");
  assert.equal(result.tokenId, "7");
});

test("getHasValidKey is consulted, and agreeing with the local expiration comparison leaves verdictDisagreement absent", async () => {
  const futureExpiration = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const { client, calls } = mockStatusClient(1n, futureExpiration, true);

  const result = await resolveMembershipStatus(client, LOCK, WALLET, VERSION, "Test Lock", NETWORK);

  assert.equal(result.status, "valid");
  assert.ok(
    calls.some((c) => c.functionName === "getHasValidKey"),
    "getHasValidKey should be consulted, not just the local expiration comparison"
  );
  assert.ok(!("verdictDisagreement" in result), "verdictDisagreement must be absent, not false, when verdicts agree");
});

test("verdictSource is absent, not present-and-undefined, when the contract answers getHasValidKey", async () => {
  const futureExpiration = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const { client } = mockStatusClient(1n, futureExpiration, true);

  const result = await resolveMembershipStatus(client, LOCK, WALLET, VERSION, "Test Lock", NETWORK);

  assert.equal(result.status, "valid");
  assert.ok(!("verdictSource" in result), "verdictSource must be absent when the contract produced the verdict");
});

test("getHasValidKey says valid despite a past expiration: the contract verdict wins and the disagreement is surfaced", async () => {
  const pastExpiration = BigInt(Math.floor(Date.now() / 1000) - 3600);
  const { client } = mockStatusClient(1n, pastExpiration, true);

  const result = await resolveMembershipStatus(client, LOCK, WALLET, VERSION, "Test Lock", NETWORK);

  assert.equal(result.status, "valid");
  assert.deepEqual(result.verdictDisagreement, { contractVerdict: "valid", localVerdict: "expired" });
});

test("getHasValidKey says expired despite a future expiration: the contract verdict wins and the disagreement is surfaced", async () => {
  const futureExpiration = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const { client } = mockStatusClient(1n, futureExpiration, false);

  const result = await resolveMembershipStatus(client, LOCK, WALLET, VERSION, "Test Lock", NETWORK);

  assert.equal(result.status, "expired");
  assert.deepEqual(result.verdictDisagreement, { contractVerdict: "expired", localVerdict: "valid" });
});

test("totalKeys 0 never consults getHasValidKey", async () => {
  const { client, calls } = mockStatusClient(0n, 0n);

  const result = await resolveMembershipStatus(client, LOCK, WALLET, VERSION, "Test Lock", NETWORK);

  assert.equal(result.status, "no_key");
  assert.ok(
    !calls.some((c) => c.functionName === "getHasValidKey"),
    "getHasValidKey should not be called when the wallet holds no keys"
  );
});

test("getHasValidKey reverting (very old locks that don't implement it) falls back to the local expiration comparison", async () => {
  const futureExpiration = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const revert = new ContractFunctionRevertedError({ abi: publicLockAbi, functionName: "getHasValidKey" });
  const { client, calls } = mockStatusClient(1n, futureExpiration, revert);

  const result = await resolveMembershipStatus(client, LOCK, WALLET, VERSION, "Test Lock", NETWORK);

  assert.ok(
    calls.some((c) => c.functionName === "getHasValidKey"),
    "getHasValidKey should still be attempted so the fallback only triggers on an actual revert"
  );
  assert.equal(result.status, "valid");
  assert.ok(
    !("verdictDisagreement" in result),
    "there is no contract verdict to disagree with once getHasValidKey reverts"
  );
  assert.equal(result.verdictSource, "local_clock");
});

test("getHasValidKey reverting, with requireContractVerdict set, fails cleanly instead of falling back", async () => {
  const futureExpiration = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const revert = new ContractFunctionRevertedError({ abi: publicLockAbi, functionName: "getHasValidKey" });
  const { client } = mockStatusClient(1n, futureExpiration, revert);

  await assert.rejects(
    resolveMembershipStatus(client, LOCK, WALLET, VERSION, "Test Lock", NETWORK, true),
    (err: unknown) => err instanceof MembershipCheckError && /getHasValidKey/.test(err.message)
  );
});

// mockStatusClient's existing revert case throws a hand-built
// ContractFunctionRevertedError directly — the one class that already took this
// fallback branch even before zero_data existed. This covers what a non-reverting
// fallback actually produces: a ContractFunctionExecutionError wrapping
// ContractFunctionZeroDataError wrapping AbiDecodingZeroDataError, with no
// ContractFunctionRevertedError anywhere in the chain.
test("getHasValidKey returning zero data (a non-reverting fallback) falls back to the local expiration comparison", async () => {
  const futureExpiration = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const zeroData = zeroDataError("getHasValidKey", [WALLET]);
  const { client, calls } = mockStatusClient(1n, futureExpiration, zeroData);

  const result = await resolveMembershipStatus(client, LOCK, WALLET, VERSION, "Test Lock", NETWORK);

  assert.ok(
    calls.some((c) => c.functionName === "getHasValidKey"),
    "getHasValidKey should still be attempted so the fallback only triggers on an actual zero-data return"
  );
  assert.equal(result.status, "valid");
  assert.ok(
    !("verdictDisagreement" in result),
    "there is no contract verdict to disagree with once getHasValidKey returns zero data"
  );
  assert.equal(result.verdictSource, "local_clock");
});

test("getHasValidKey returning zero data, with requireContractVerdict set, fails cleanly instead of falling back", async () => {
  const futureExpiration = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const zeroData = zeroDataError("getHasValidKey", [WALLET]);
  const { client } = mockStatusClient(1n, futureExpiration, zeroData);

  await assert.rejects(
    resolveMembershipStatus(client, LOCK, WALLET, VERSION, "Test Lock", NETWORK, true),
    (err: unknown) => err instanceof MembershipCheckError && /getHasValidKey/.test(err.message)
  );
});

test("requireContractVerdict set, but getHasValidKey answers directly: the contract path is untouched", async () => {
  const futureExpiration = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const { client } = mockStatusClient(1n, futureExpiration, true);

  const result = await resolveMembershipStatus(client, LOCK, WALLET, VERSION, "Test Lock", NETWORK, true);

  assert.equal(result.status, "valid");
  assert.ok(!("verdictSource" in result), "verdictSource must still be absent when the contract answers");
});
