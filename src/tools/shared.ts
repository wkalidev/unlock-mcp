import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, isAddress, type PublicClient } from "viem";
import { z } from "zod";
import { publicLockAbi } from "../abi/publicLock.js";
import type { NetworkConfig } from "../networks.js";

// PublicLock stamps both "never expires" keys and "unlimited" maxNumberOfKeys with the
// max uint256 sentinel. It overflows JS Date/Number, so it must be special-cased rather
// than converted. Confirmed against unlock-protocol/unlock (PublicLockV14.sol and
// packages/unlock-js/src/constants.ts, MAX_UINT / ethers.MaxUint256) — both fields use
// the same sentinel.
export const UNLIMITED = 2n ** 256n - 1n;

// A factory, not a shared singleton: the MCP SDK's zod-to-json-schema conversion caches
// schemas by object identity and collapses a second reference to the same instance into
// a $ref (e.g. walletAddress -> {"$ref": "#/properties/lockAddress"}) — valid JSON
// Schema, but many MCP clients don't dereference it and see an untyped parameter. Each
// call here returns a distinct schema object so every field's type stays inline.
export function addressSchema(description: string) {
  return z
    .string()
    .refine((value) => isAddress(value), { message: "not a valid 0x address" })
    .transform((value) => value as `0x${string}`)
    .describe(description);
}

export class UnlockToolError extends Error {}

type ErrorClass = "revert" | "zero_data" | "transport" | "unknown";

// Discriminate structurally, not by message text: a genuine contract revert always
// surfaces a ContractFunctionRevertedError in viem's cause chain — that's the only
// reliable signal that the address isn't a working PublicLock. A non-reverting
// fallback (or any call to a function the contract doesn't implement) instead
// surfaces a ContractFunctionZeroDataError — the call returned "0x", so the contract
// answered, it just didn't return the data the ABI expected; that's not a transport
// failure either. Everything else thrown by viem (timeout, connection failure, rate
// limiting, 5xx, ...) is a transport-side failure, regardless of which RPC in the
// fallback chain ultimately gave up.
export function classifyError(err: unknown): ErrorClass {
  if (!(err instanceof BaseError)) return "unknown";
  if (err.walk((e) => e instanceof ContractFunctionRevertedError) !== null) return "revert";
  if (err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null) return "zero_data";
  return "transport";
}

export function rpcFailureMessage(network: NetworkConfig): string {
  return `RPC request to ${network.name} failed on every configured endpoint (${network.rpcUrls.join(", ")}) — the network may be unreachable, timing out, or rate-limiting. Try again shortly.`;
}

export type LockClassification =
  | { status: "not_a_contract" }
  | { status: "not_a_lock" }
  | { status: "ok"; version: number; name: string };

// Shared by unlock_check_membership and unlock_get_lock: both need to tell "not a
// contract" from "not a PublicLock" from "a working lock" before doing anything else,
// and both classify the same way — a missing bytecode vs. a revert on the two calls
// every PublicLock version implements.
export async function classifyLock(
  client: Pick<PublicClient, "getCode" | "readContract">,
  lockAddress: `0x${string}`,
  network: NetworkConfig
): Promise<LockClassification> {
  let bytecode: `0x${string}` | undefined;
  try {
    bytecode = await client.getCode({ address: lockAddress });
  } catch (err) {
    if (classifyError(err) === "unknown") {
      throw new UnlockToolError(`Unexpected error reading from ${network.name}: ${(err as Error).message}`);
    }
    throw new UnlockToolError(rpcFailureMessage(network));
  }

  if (!bytecode || bytecode === "0x") {
    return { status: "not_a_contract" };
  }

  try {
    const [version, name] = await Promise.all([
      client.readContract({ address: lockAddress, abi: publicLockAbi, functionName: "publicLockVersion" }),
      client.readContract({ address: lockAddress, abi: publicLockAbi, functionName: "name" }),
    ]);
    return { status: "ok", version, name };
  } catch (err) {
    const kind = classifyError(err);
    // A non-reverting fallback answers with zero data rather than a revert, but it's
    // just as clear a signal that this isn't a PublicLock: an address with code that
    // doesn't implement the function isn't a lock either way.
    if (kind === "revert" || kind === "zero_data") {
      return { status: "not_a_lock" };
    }
    if (kind === "transport") {
      throw new UnlockToolError(rpcFailureMessage(network));
    }
    throw new UnlockToolError(`Unexpected error reading lock data: ${(err as Error).message}`);
  }
}
