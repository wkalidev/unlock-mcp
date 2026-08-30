import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { z } from "zod";
import { publicLockAbi } from "../abi/publicLock.js";
import { getNetwork, toViemChain, type NetworkConfig } from "../networks.js";
import { UnlockToolError, addressSchema, classifyError, classifyLock, rpcFailureMessage, UNLIMITED } from "./shared.js";

export const checkMembershipInputShape = {
  lockAddress: addressSchema("Address of the PublicLock contract to check"),
  walletAddress: addressSchema("Wallet address to check for a valid key"),
  network: z
    .string()
    .default("base")
    .describe('Network name (defaults to "base")'),
};

const checkMembershipInputSchema = z.object(checkMembershipInputShape);

export type CheckMembershipInput = z.input<typeof checkMembershipInputSchema>;

// Below this, PublicLock's keyExpirationTimestampFor(address) signature was used;
// from this version on, it's keyExpirationTimestampFor(tokenId).
const TOKEN_ID_SIGNATURE_MIN_VERSION = 10;

function formatRelativeTime(target: Date, now: Date): string {
  const diffSec = Math.round((target.getTime() - now.getTime()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["week", 60 * 60 * 24 * 7],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
  ];
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, secondsInUnit] of units) {
    if (Math.abs(diffSec) >= secondsInUnit) {
      return rtf.format(Math.round(diffSec / secondsInUnit), unit);
    }
  }
  return rtf.format(diffSec, "second");
}

// Kept as its own exported name (rather than importing callers switching to
// UnlockToolError directly) since index.ts's catch branch reads more clearly naming
// the tool it came from.
const MembershipCheckError = UnlockToolError;
export { MembershipCheckError };

interface MembershipResult {
  status: "valid" | "expired" | "no_key" | "not_a_contract" | "not_a_lock";
  network: string;
  lockAddress?: string;
  lockName?: string;
  tokenId?: string;
  expiresAt?: string;
  expiresRelative?: string;
  // Present only when getHasValidKey's verdict disagrees with comparing expiresAt to
  // the local clock (e.g. clock skew, or a lock with non-standard validity rules).
  // Absent — not false — when they agree, so existing consumers see no change.
  verdictDisagreement?: { contractVerdict: "valid" | "expired"; localVerdict: "valid" | "expired" };
}

// Only needs readContract, so tests can pass a minimal mock rather than a full PublicClient.
export async function resolveBestKey(
  client: Pick<PublicClient, "readContract">,
  lockAddress: `0x${string}`,
  walletAddress: `0x${string}`,
  keyCount: bigint,
  version: number
): Promise<{ tokenId: bigint; expiration: bigint }> {
  const indices = Array.from({ length: Number(keyCount) }, (_, i) => BigInt(i));

  const tokenIds = await Promise.all(
    indices.map((index) =>
      client.readContract({
        address: lockAddress,
        abi: publicLockAbi,
        functionName: "tokenOfOwnerByIndex",
        args: [walletAddress, index],
      })
    )
  );

  const usesTokenIdSignature = version >= TOKEN_ID_SIGNATURE_MIN_VERSION;

  if (!usesTokenIdSignature) {
    // Pre-v10 PublicLock only exposes keyExpirationTimestampFor(address) — one
    // expiration per wallet, not per key — so there's no per-tokenId value to
    // select between; every key the wallet owns shares this same expiration.
    const expiration = await client.readContract({
      address: lockAddress,
      abi: publicLockAbi,
      functionName: "keyExpirationTimestampFor",
      args: [walletAddress],
    });
    return { tokenId: tokenIds[0]!, expiration };
  }

  const expirations = await Promise.all(
    tokenIds.map((tokenId) =>
      client.readContract({
        address: lockAddress,
        abi: publicLockAbi,
        functionName: "keyExpirationTimestampFor",
        args: [tokenId],
      })
    )
  );

  let best = { tokenId: tokenIds[0]!, expiration: expirations[0]! };
  for (let i = 1; i < tokenIds.length; i++) {
    if (expirations[i]! > best.expiration) {
      best = { tokenId: tokenIds[i]!, expiration: expirations[i]! };
    }
  }
  return best;
}

export async function checkMembership(rawInput: CheckMembershipInput): Promise<MembershipResult> {
  const input = checkMembershipInputSchema.parse(rawInput);
  const network = getNetwork(input.network);
  const client = createPublicClient({
    chain: toViemChain(network),
    transport: fallback(network.rpcUrls.map((url) => http(url, { timeout: 10_000 }))),
  });

  const classification = await classifyLock(client, input.lockAddress, network);
  if (classification.status !== "ok") {
    return { status: classification.status, network: network.name, lockAddress: input.lockAddress };
  }

  return resolveMembershipStatus(
    client,
    input.lockAddress,
    input.walletAddress,
    classification.version,
    classification.name,
    network
  );
}

// Split out from checkMembership so it can be exercised against a mocked client:
// checkMembership itself owns network/RPC setup and the not_a_contract / not_a_lock
// checks, none of which this needs.
export async function resolveMembershipStatus(
  client: Pick<PublicClient, "readContract">,
  lockAddress: `0x${string}`,
  walletAddress: `0x${string}`,
  version: number,
  lockName: string,
  network: NetworkConfig
): Promise<MembershipResult> {
  // totalKeys, not balanceOf: on v10+ locks balanceOf counts only currently-valid keys,
  // so a wallet holding an expired key reads identically to one that never held a key.
  // Reach for totalKeys here even though balanceOf is the reflexive ERC-721 choice —
  // it counts every key ever minted to the owner, and tokenOfOwnerByIndex is bounded
  // by totalKeys rather than balanceOf, so it still enumerates expired keys.
  let keyCount: bigint;
  try {
    keyCount = await client.readContract({
      address: lockAddress,
      abi: publicLockAbi,
      functionName: "totalKeys",
      args: [walletAddress],
    });
  } catch (err) {
    if (classifyError(err) === "transport") {
      throw new MembershipCheckError(rpcFailureMessage(network));
    }
    throw new MembershipCheckError(`Unexpected error reading key count: ${(err as Error).message}`);
  }

  if (keyCount === 0n) {
    return { status: "no_key", lockName, network: network.name };
  }

  let best: { tokenId: bigint; expiration: bigint };
  try {
    best = await resolveBestKey(client, lockAddress, walletAddress, keyCount, version);
  } catch (err) {
    if (classifyError(err) === "transport") {
      throw new MembershipCheckError(rpcFailureMessage(network));
    }
    throw new MembershipCheckError(`Unexpected error reading key expiration: ${(err as Error).message}`);
  }

  const now = new Date();
  // best.expiration/now only ever explain the verdict (expiresAt, expiresRelative) —
  // the verdict itself comes from getHasValidKey below. localVerdict is still computed
  // so a disagreement between the two can be surfaced rather than silently dropped.
  const localVerdict: "valid" | "expired" =
    best.expiration === UNLIMITED || Number(best.expiration) * 1000 > now.getTime() ? "valid" : "expired";

  let status: "valid" | "expired" = localVerdict;
  let verdictDisagreement: MembershipResult["verdictDisagreement"];
  try {
    const hasValidKey = await client.readContract({
      address: lockAddress,
      abi: publicLockAbi,
      functionName: "getHasValidKey",
      args: [walletAddress],
    });
    const contractVerdict: "valid" | "expired" = hasValidKey ? "valid" : "expired";
    status = contractVerdict;
    if (contractVerdict !== localVerdict) {
      verdictDisagreement = { contractVerdict, localVerdict };
    }
  } catch (err) {
    const kind = classifyError(err);
    if (kind === "transport") {
      throw new MembershipCheckError(rpcFailureMessage(network));
    }
    if (kind === "unknown") {
      throw new MembershipCheckError(`Unexpected error reading key validity: ${(err as Error).message}`);
    }
    // getHasValidKey doesn't exist on very old locks — fall back to the local
    // comparison instead of failing the call.
    status = localVerdict;
  }

  if (best.expiration === UNLIMITED) {
    return {
      status,
      lockName,
      network: network.name,
      tokenId: best.tokenId.toString(),
      expiresRelative: "never",
      ...(verdictDisagreement ? { verdictDisagreement } : {}),
    };
  }

  const expiresAt = new Date(Number(best.expiration) * 1000);

  return {
    status,
    lockName,
    network: network.name,
    tokenId: best.tokenId.toString(),
    expiresAt: expiresAt.toISOString(),
    expiresRelative: formatRelativeTime(expiresAt, now),
    ...(verdictDisagreement ? { verdictDisagreement } : {}),
  };
}

export function formatMembershipResult(result: MembershipResult): string {
  switch (result.status) {
    case "not_a_contract":
      return `Not a contract: ${result.lockAddress} is not a contract on ${result.network}.`;
    case "not_a_lock":
      return `Not a lock: ${result.lockAddress} does not look like an Unlock Protocol PublicLock contract on ${result.network}.`;
    case "no_key":
      return `No key: this wallet does not hold any key for "${result.lockName}" on ${result.network}.`;
    case "expired":
      return `Expired key: this wallet held a key for "${result.lockName}" on ${result.network} (tokenId ${result.tokenId}) that expired on ${result.expiresAt} (${result.expiresRelative}).`;
    case "valid":
      if (result.expiresRelative === "never") {
        return `Valid key: this wallet holds a non-expiring key for "${result.lockName}" on ${result.network} (tokenId ${result.tokenId}). It never expires.`;
      }
      return `Valid key: this wallet holds a key for "${result.lockName}" on ${result.network} (tokenId ${result.tokenId}) that expires on ${result.expiresAt} (${result.expiresRelative}).`;
  }
}
