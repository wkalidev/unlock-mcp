import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  fallback,
  http,
  isAddress,
  type PublicClient,
} from "viem";
import { z } from "zod";
import { publicLockAbi } from "../abi/publicLock.js";
import { getNetwork, toViemChain, type NetworkConfig } from "../networks.js";

const addressSchema = z
  .string()
  .refine((value) => isAddress(value), { message: "not a valid 0x address" })
  .transform((value) => value as `0x${string}`);

export const checkMembershipInputShape = {
  lockAddress: addressSchema.describe("Address of the PublicLock contract to check"),
  walletAddress: addressSchema.describe("Wallet address to check for a valid key"),
  network: z
    .string()
    .default("base")
    .describe('Network name (defaults to "base")'),
};

const checkMembershipInputSchema = z.object(checkMembershipInputShape);

export type CheckMembershipInput = z.input<typeof checkMembershipInputSchema>;

// Keys created without an expiration (lifetime keys) are stamped with the max uint256
// value by the PublicLock contract. That value overflows JS Date, so it must be
// special-cased rather than converted.
const NEVER_EXPIRES = 2n ** 256n - 1n;

// Below this, PublicLock's keyExpirationTimestampFor(address) signature was used;
// from this version on, it's keyExpirationTimestampFor(tokenId).
const TOKEN_ID_SIGNATURE_MIN_VERSION = 10;

type ErrorClass = "revert" | "transport" | "unknown";

// Discriminate structurally, not by message text: a genuine contract revert always
// surfaces a ContractFunctionRevertedError in viem's cause chain — that's the only
// reliable signal that the address isn't a working PublicLock. Everything else thrown
// by viem (timeout, connection failure, rate limiting, 5xx, ...) is a transport-side
// failure, regardless of which RPC in the fallback chain ultimately gave up.
function classifyError(err: unknown): ErrorClass {
  if (!(err instanceof BaseError)) return "unknown";
  return err.walk((e) => e instanceof ContractFunctionRevertedError) !== null ? "revert" : "transport";
}

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

export class MembershipCheckError extends Error {}

interface MembershipResult {
  status: "valid" | "expired" | "no_key" | "not_a_contract" | "not_a_lock";
  network: string;
  lockAddress?: string;
  lockName?: string;
  tokenId?: string;
  expiresAt?: string;
  expiresRelative?: string;
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

  const expirations = await Promise.all(
    tokenIds.map((tokenId) =>
      usesTokenIdSignature
        ? client.readContract({
            address: lockAddress,
            abi: publicLockAbi,
            functionName: "keyExpirationTimestampFor",
            args: [tokenId],
          })
        : client.readContract({
            address: lockAddress,
            abi: publicLockAbi,
            functionName: "keyExpirationTimestampFor",
            args: [walletAddress],
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

  const rpcFailureMessage = () =>
    `RPC request to ${network.name} failed on every configured endpoint (${network.rpcUrls.join(", ")}) — the network may be unreachable, timing out, or rate-limiting. Try again shortly.`;

  let bytecode: `0x${string}` | undefined;
  try {
    bytecode = await client.getCode({ address: input.lockAddress });
  } catch (err) {
    if (classifyError(err) === "unknown") {
      throw new MembershipCheckError(`Unexpected error reading from ${network.name}: ${(err as Error).message}`);
    }
    throw new MembershipCheckError(rpcFailureMessage());
  }

  if (!bytecode || bytecode === "0x") {
    return { status: "not_a_contract", network: network.name, lockAddress: input.lockAddress };
  }

  let version: number;
  let lockName: string;
  try {
    [version, lockName] = await Promise.all([
      client.readContract({
        address: input.lockAddress,
        abi: publicLockAbi,
        functionName: "publicLockVersion",
      }),
      client.readContract({
        address: input.lockAddress,
        abi: publicLockAbi,
        functionName: "name",
      }),
    ]);
  } catch (err) {
    const kind = classifyError(err);
    if (kind === "revert") {
      return { status: "not_a_lock", network: network.name, lockAddress: input.lockAddress };
    }
    if (kind === "transport") {
      throw new MembershipCheckError(rpcFailureMessage());
    }
    throw new MembershipCheckError(`Unexpected error reading lock data: ${(err as Error).message}`);
  }

  return resolveMembershipStatus(client, input.lockAddress, input.walletAddress, version, lockName, network);
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
  const rpcFailureMessage = () =>
    `RPC request to ${network.name} failed on every configured endpoint (${network.rpcUrls.join(", ")}) — the network may be unreachable, timing out, or rate-limiting. Try again shortly.`;

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
      throw new MembershipCheckError(rpcFailureMessage());
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
      throw new MembershipCheckError(rpcFailureMessage());
    }
    throw new MembershipCheckError(`Unexpected error reading key expiration: ${(err as Error).message}`);
  }

  const now = new Date();

  if (best.expiration === NEVER_EXPIRES) {
    return {
      status: "valid",
      lockName,
      network: network.name,
      tokenId: best.tokenId.toString(),
      expiresRelative: "never",
    };
  }

  const expiresAt = new Date(Number(best.expiration) * 1000);
  const isValid = expiresAt.getTime() > now.getTime();

  return {
    status: isValid ? "valid" : "expired",
    lockName,
    network: network.name,
    tokenId: best.tokenId.toString(),
    expiresAt: expiresAt.toISOString(),
    expiresRelative: formatRelativeTime(expiresAt, now),
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
