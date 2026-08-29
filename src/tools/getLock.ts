import { createPublicClient, erc20Abi, fallback, formatUnits, http, type PublicClient, zeroAddress } from "viem";
import { z } from "zod";
import { publicLockAbi } from "../abi/publicLock.js";
import { getNetwork, toViemChain, type NetworkConfig } from "../networks.js";
import { addressSchema, classifyError, classifyLock, rpcFailureMessage, UnlockToolError, UNLIMITED } from "./shared.js";

export const getLockInputShape = {
  lockAddress: addressSchema("Address of the PublicLock contract to read"),
  network: z.string().default("base").describe('Network name (defaults to "base")'),
};

const getLockInputSchema = z.object(getLockInputShape);

export type GetLockInput = z.input<typeof getLockInputSchema>;

const GetLockError = UnlockToolError;
export { GetLockError };

type DurationInfo = { unlimited: true } | { unlimited: false; seconds: string; humanReadable: string };
type MaxKeysInfo = { unlimited: true } | { unlimited: false; value: string };

interface KeyPriceInfo {
  raw: string;
  amount: string;
  currency: "native" | "erc20";
  tokenAddress: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
}

// Lock managers are deliberately left out: PublicLock has no enumerable getter for the
// role (it's a plain OpenZeppelin AccessControl role, not AccessControlEnumerable) —
// only isLockManager(address), a point check against one address you'd already have to
// know. The only way to get the actual list is to replay RoleGranted/RoleRevoked logs
// (an unbounded eth_getLogs scan from deployment, not a cheap read) or ask the
// subgraph, which this tool intentionally doesn't do since it's meant to reflect
// current on-chain state via RPC only.
interface GetLockResult {
  status: "ok" | "not_a_contract" | "not_a_lock";
  network: string;
  lockAddress: string;
  name?: string;
  symbol?: string;
  version?: number;
  keyPrice?: KeyPriceInfo;
  expirationDuration?: DurationInfo;
  maxNumberOfKeys?: MaxKeysInfo;
  totalKeysSold?: string;
}

// Formats a duration in seconds as the largest whole unit it fits, e.g. 86400 -> "1 day".
// Good enough for a lock's fixed duration (not a countdown, so no need for the
// multi-unit precision formatRelativeTime uses in checkMembership.ts).
function formatDuration(totalSeconds: number): string {
  const units: [string, number][] = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["week", 60 * 60 * 24 * 7],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
  ];
  for (const [unit, secondsInUnit] of units) {
    if (totalSeconds >= secondsInUnit) {
      const count = Math.round(totalSeconds / secondsInUnit);
      return `${count} ${unit}${count === 1 ? "" : "s"}`;
    }
  }
  return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
}

export async function getLock(rawInput: GetLockInput): Promise<GetLockResult> {
  const input = getLockInputSchema.parse(rawInput);
  const network = getNetwork(input.network);
  const client = createPublicClient({
    chain: toViemChain(network),
    transport: fallback(network.rpcUrls.map((url) => http(url, { timeout: 10_000 }))),
  });

  const classification = await classifyLock(client, input.lockAddress, network);
  if (classification.status !== "ok") {
    return { status: classification.status, network: network.name, lockAddress: input.lockAddress };
  }

  return resolveLockDetails(client, input.lockAddress, classification.version, classification.name, network);
}

// Split out from getLock so it can be exercised against a mocked client, the same way
// resolveMembershipStatus is: getLock itself owns network/RPC setup and the
// not_a_contract / not_a_lock classification, neither of which this needs.
export async function resolveLockDetails(
  client: Pick<PublicClient, "readContract">,
  lockAddress: `0x${string}`,
  version: number,
  name: string,
  network: NetworkConfig
): Promise<GetLockResult> {
  let symbol: string;
  let keyPrice: bigint;
  let tokenAddress: `0x${string}`;
  let expirationDuration: bigint;
  let maxNumberOfKeys: bigint;
  let totalSupply: bigint;
  try {
    [symbol, keyPrice, tokenAddress, expirationDuration, maxNumberOfKeys, totalSupply] = await Promise.all([
      client.readContract({ address: lockAddress, abi: publicLockAbi, functionName: "symbol" }),
      client.readContract({ address: lockAddress, abi: publicLockAbi, functionName: "keyPrice" }),
      client.readContract({ address: lockAddress, abi: publicLockAbi, functionName: "tokenAddress" }),
      client.readContract({ address: lockAddress, abi: publicLockAbi, functionName: "expirationDuration" }),
      client.readContract({ address: lockAddress, abi: publicLockAbi, functionName: "maxNumberOfKeys" }),
      client.readContract({ address: lockAddress, abi: publicLockAbi, functionName: "totalSupply" }),
    ]);
  } catch (err) {
    if (classifyError(err) === "transport") {
      throw new GetLockError(rpcFailureMessage(network));
    }
    throw new GetLockError(`Unexpected error reading lock data: ${(err as Error).message}`);
  }

  let keyPriceInfo: KeyPriceInfo;
  if (tokenAddress === zeroAddress) {
    keyPriceInfo = {
      raw: keyPrice.toString(),
      amount: formatUnits(keyPrice, network.nativeCurrency.decimals),
      currency: "native",
      tokenAddress,
      tokenSymbol: network.nativeCurrency.symbol,
      tokenDecimals: network.nativeCurrency.decimals,
    };
  } else {
    let tokenSymbol: string | undefined;
    let tokenDecimals: number | undefined;
    try {
      [tokenSymbol, tokenDecimals] = await Promise.all([
        client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "symbol" }),
        client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "decimals" }),
      ]);
    } catch (err) {
      // A transport failure here is the same class of problem as above; a revert (a
      // non-standard token missing symbol()/decimals()) is not — the lock read still
      // succeeded, so degrade to the raw price rather than failing the whole call.
      if (classifyError(err) === "transport") {
        throw new GetLockError(rpcFailureMessage(network));
      }
    }
    keyPriceInfo = {
      raw: keyPrice.toString(),
      amount: tokenDecimals !== undefined ? formatUnits(keyPrice, tokenDecimals) : keyPrice.toString(),
      currency: "erc20",
      tokenAddress,
      tokenSymbol,
      tokenDecimals,
    };
  }

  const expirationDurationInfo: DurationInfo =
    expirationDuration === UNLIMITED
      ? { unlimited: true }
      : { unlimited: false, seconds: expirationDuration.toString(), humanReadable: formatDuration(Number(expirationDuration)) };

  const maxNumberOfKeysInfo: MaxKeysInfo =
    maxNumberOfKeys === UNLIMITED ? { unlimited: true } : { unlimited: false, value: maxNumberOfKeys.toString() };

  return {
    status: "ok",
    network: network.name,
    lockAddress,
    name,
    symbol,
    version,
    keyPrice: keyPriceInfo,
    expirationDuration: expirationDurationInfo,
    maxNumberOfKeys: maxNumberOfKeysInfo,
    totalKeysSold: totalSupply.toString(),
  };
}

export function formatGetLockResult(result: GetLockResult): string {
  if (result.status === "not_a_contract") {
    return `Not a contract: ${result.lockAddress} is not a contract on ${result.network}.`;
  }
  if (result.status === "not_a_lock") {
    return `Not a lock: ${result.lockAddress} does not look like an Unlock Protocol PublicLock contract on ${result.network}.`;
  }

  const price = result.keyPrice!;
  const priceText =
    price.amount === "0"
      ? "free"
      : `${price.amount} ${price.tokenSymbol ?? (price.currency === "native" ? "" : price.tokenAddress)}`.trim();

  const duration = result.expirationDuration!;
  const durationText = duration.unlimited ? "unlimited (keys never expire)" : duration.humanReadable;

  const maxKeys = result.maxNumberOfKeys!;
  const maxKeysText = maxKeys.unlimited ? "unlimited" : maxKeys.value;

  const lines = [
    `Lock: "${result.name}" (${result.symbol}) at ${result.lockAddress} on ${result.network}, PublicLock v${result.version}.`,
    `Key price: ${priceText}${price.currency === "erc20" ? ` (token ${price.tokenAddress})` : ""}.`,
    `Expiration duration: ${durationText}.`,
    `Max number of keys: ${maxKeysText}.`,
    `Total keys sold: ${result.totalKeysSold}.`,
  ];
  return lines.join("\n");
}
