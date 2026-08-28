import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicClient } from "viem";
import { resolveBestKey } from "./checkMembership.js";

const LOCK = "0x1111111111111111111111111111111111111a" as const;
const WALLET = "0x2222222222222222222222222222222222222b" as const;

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

test("v10+ locks (version 14) call keyExpirationTimestampFor with the tokenId", async () => {
  const calls: { functionName: string; args: readonly unknown[] }[] = [];
  const client = mockClient(calls);

  await resolveBestKey(client, LOCK, WALLET, 1n, 14);

  const expirationCall = calls.find((c) => c.functionName === "keyExpirationTimestampFor");
  assert.ok(expirationCall, "keyExpirationTimestampFor was not called");
  assert.deepEqual(expirationCall.args, [42n]);
});
