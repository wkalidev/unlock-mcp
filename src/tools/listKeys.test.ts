import assert from "node:assert/strict";
import { test } from "node:test";
import { UNLIMITED } from "./shared.js";

// listKeys() calls the subgraph directly via global fetch, so these tests stub
// globalThis.fetch for the duration of each test — the same "swap the one thing that
// crosses a process boundary" approach the mocked readContract client uses for the
// RPC-backed tools.

function stubFetch(body: unknown, status = 200) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const LOCK = "0x24fa20fd4c6c497c4b27d830a7343736df6b1d66";
const WALLET = "0xdeacde6ec27fd0cd972c1232c4f0d4171dda2357";

test("listKeys reports no keys as an empty, non-error result", async () => {
  const restore = stubFetch({ data: { keys: [] } });
  try {
    const { listKeys, formatListKeysResult } = await import("./listKeys.js");
    const result = await listKeys({ walletAddress: WALLET, network: "base" });
    assert.equal(result.keys.length, 0);
    assert.match(formatListKeysResult(result), /No keys/);
  } finally {
    restore();
  }
});

test("listKeys marks a future-expiring, non-cancelled key as valid", async () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const restore = stubFetch({
    data: {
      keys: [
        { tokenId: "1", expiration: String(future), cancelled: false, lock: { address: LOCK, name: "Test Lock" } },
      ],
    },
  });
  try {
    const { listKeys } = await import("./listKeys.js");
    const result = await listKeys({ walletAddress: WALLET, network: "base" });
    assert.equal(result.keys.length, 1);
    assert.equal(result.keys[0]!.isValid, true);
    assert.equal(result.keys[0]!.tokenId, "1");
    assert.equal(result.keys[0]!.lockAddress, LOCK);
  } finally {
    restore();
  }
});

test("listKeys marks a past-expiring key as invalid and a never-expiring key as valid", async () => {
  const past = Math.floor(Date.now() / 1000) - 3600;
  const restore = stubFetch({
    data: {
      keys: [
        { tokenId: "1", expiration: String(past), cancelled: false, lock: { address: LOCK, name: "Test Lock" } },
        { tokenId: "2", expiration: UNLIMITED.toString(), cancelled: false, lock: { address: LOCK, name: "Test Lock" } },
      ],
    },
  });
  try {
    const { listKeys } = await import("./listKeys.js");
    const result = await listKeys({ walletAddress: WALLET, network: "base", includeExpired: true });
    const expired = result.keys.find((k) => k.tokenId === "1")!;
    const lifetime = result.keys.find((k) => k.tokenId === "2")!;
    assert.equal(expired.isValid, false);
    assert.equal(lifetime.isValid, true);
    assert.equal(lifetime.expiresAt, "never");
  } finally {
    restore();
  }
});

test("listKeys treats a cancelled key as invalid even if unexpired", async () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const restore = stubFetch({
    data: {
      keys: [
        { tokenId: "1", expiration: String(future), cancelled: true, lock: { address: LOCK, name: "Test Lock" } },
      ],
    },
  });
  try {
    const { listKeys } = await import("./listKeys.js");
    const result = await listKeys({ walletAddress: WALLET, network: "base", includeExpired: true });
    assert.equal(result.keys[0]!.isValid, false);
  } finally {
    restore();
  }
});

test("listKeys caps results at 100 and reports truncation", async () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const keys = Array.from({ length: 101 }, (_, i) => ({
    tokenId: String(i),
    expiration: String(future - i),
    cancelled: false,
    lock: { address: LOCK, name: "Test Lock" },
  }));
  const restore = stubFetch({ data: { keys } });
  try {
    const { listKeys } = await import("./listKeys.js");
    const result = await listKeys({ walletAddress: WALLET, network: "base" });
    assert.equal(result.keys.length, 100);
    assert.equal(result.truncated, true);
  } finally {
    restore();
  }
});

test("listKeys surfaces a subgraph HTTP failure as a SubgraphError", async () => {
  const restore = stubFetch({}, 503);
  try {
    const { listKeys, ListKeysError } = await import("./listKeys.js");
    await assert.rejects(() => listKeys({ walletAddress: WALLET, network: "base" }), ListKeysError);
  } finally {
    restore();
  }
});

test("listKeys surfaces subgraph GraphQL errors as a SubgraphError", async () => {
  const restore = stubFetch({ errors: [{ message: "field not found" }] });
  try {
    const { listKeys, ListKeysError } = await import("./listKeys.js");
    await assert.rejects(() => listKeys({ walletAddress: WALLET, network: "base" }), ListKeysError);
  } finally {
    restore();
  }
});
