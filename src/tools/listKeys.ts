import { z } from "zod";
import { getNetwork } from "../networks.js";
import { querySubgraph, SubgraphError } from "../subgraph.js";
import { addressSchema, UNLIMITED } from "./shared.js";

export const listKeysInputShape = {
  walletAddress: addressSchema.describe("Wallet address to list Unlock Protocol keys for"),
  network: z.string().default("base").describe('Network name (defaults to "base")'),
  includeExpired: z
    .boolean()
    .default(false)
    .describe("Include expired and cancelled keys, not just currently valid ones (default false)"),
};

const listKeysInputSchema = z.object(listKeysInputShape);

export type ListKeysInput = z.input<typeof listKeysInputSchema>;

const ListKeysError = SubgraphError;
export { ListKeysError };

// One more than the cap, so a full page tells us there may be more without a second
// round trip just to count.
const RESULT_CAP = 100;
const FETCH_LIMIT = RESULT_CAP + 1;

interface KeyEntry {
  lockAddress: string;
  lockName: string;
  tokenId: string;
  expiresAt: string;
  isValid: boolean;
}

interface ListKeysResult {
  network: string;
  walletAddress: string;
  keys: KeyEntry[];
  truncated: boolean;
}

interface SubgraphKey {
  tokenId: string;
  expiration: string;
  cancelled: boolean | null;
  lock: { address: string; name: string | null };
}

interface KeysQueryData {
  keys: SubgraphKey[];
}

const KEYS_QUERY = `
  query WalletKeys($where: Key_filter!, $first: Int!) {
    keys(where: $where, orderBy: expiration, orderDirection: desc, first: $first) {
      tokenId
      expiration
      cancelled
      lock {
        address
        name
      }
    }
  }
`;

export async function listKeys(rawInput: ListKeysInput): Promise<ListKeysResult> {
  const input = listKeysInputSchema.parse(rawInput);
  const network = getNetwork(input.network);

  const where: Record<string, unknown> = { owner: input.walletAddress.toLowerCase() };
  if (!input.includeExpired) {
    // cancelled_not (rather than cancelled: false) also matches keys where the field
    // was never set, since it's a nullable Boolean in the schema.
    where.cancelled_not = true;
    where.expiration_gt = Math.floor(Date.now() / 1000).toString();
  }

  let data: KeysQueryData;
  try {
    data = await querySubgraph<KeysQueryData>(network.subgraph, KEYS_QUERY, { where, first: FETCH_LIMIT });
  } catch (err) {
    if (err instanceof SubgraphError) throw err;
    throw new ListKeysError(`Unexpected error querying the subgraph: ${(err as Error).message}`);
  }

  const truncated = data.keys.length > RESULT_CAP;
  const page = truncated ? data.keys.slice(0, RESULT_CAP) : data.keys;

  const now = Math.floor(Date.now() / 1000);
  const keys: KeyEntry[] = page.map((key) => {
    const expiration = BigInt(key.expiration);
    const isValid = !key.cancelled && (expiration === UNLIMITED || expiration > BigInt(now));
    return {
      lockAddress: key.lock.address,
      lockName: key.lock.name ?? "(unnamed lock)",
      tokenId: key.tokenId,
      expiresAt: expiration === UNLIMITED ? "never" : new Date(Number(expiration) * 1000).toISOString(),
      isValid,
    };
  });

  return { network: network.name, walletAddress: input.walletAddress, keys, truncated };
}

export function formatListKeysResult(result: ListKeysResult): string {
  if (result.keys.length === 0) {
    return `No keys: ${result.walletAddress} does not hold any Unlock Protocol keys on ${result.network}.`;
  }

  const lines = result.keys.map((key) => {
    const validity = key.isValid ? "valid" : "expired";
    const expiry = key.expiresAt === "never" ? "never expires" : `expires ${key.expiresAt}`;
    return `- "${key.lockName}" (${key.lockAddress}), tokenId ${key.tokenId}, ${validity}, ${expiry}`;
  });

  const header = `${result.keys.length} key(s) held by ${result.walletAddress} on ${result.network}:`;
  const footer = result.truncated ? `\n(Results capped at ${RESULT_CAP}; more keys may exist.)` : "";
  return `${header}\n${lines.join("\n")}${footer}`;
}
