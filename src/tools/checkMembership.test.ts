import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicClient } from "viem";
import type { NetworkConfig } from "../networks.js";
import { resolveBestKey, resolveMembershipStatus } from "./checkMembership.js";

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

// Mocks totalKeys, tokenOfOwnerByIndex, and keyExpirationTimestampFor for a single
// key (tokenId 7) so resolveMembershipStatus can be driven end-to-end without a
// network call.
function mockStatusClient(
  totalKeys: bigint,
  expiration: bigint
): { client: Pick<PublicClient, "readContract">; calls: { functionName: string; args: readonly unknown[] }[] } {
  const calls: { functionName: string; args: readonly unknown[] }[] = [];
  const client: Pick<PublicClient, "readContract"> = {
    readContract: (async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      calls.push({ functionName, args });
      if (functionName === "totalKeys") return totalKeys;
      if (functionName === "tokenOfOwnerByIndex") return 7n;
      if (functionName === "keyExpirationTimestampFor") return expiration;
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
