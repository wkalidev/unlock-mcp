import type { Chain } from "viem";

export interface NetworkConfig {
  /** EVM chain id */
  id: number;
  /** Human-readable name */
  name: string;
  /** RPC endpoints, tried in order — first is primary, rest are fallbacks */
  rpcUrls: string[];
  /** Unlock factory contract address on this chain */
  unlockAddress: `0x${string}`;
  /** Unlock's public subgraph endpoint for this chain */
  subgraph: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
}

export const networks: Record<string, NetworkConfig> = {
  base: {
    id: 8453,
    name: "Base",
    // Unlock runs a public RPC per chain (proxies the official endpoint, no extra rate
    // limiting on Unlock's side); mainnet.base.org is the fallback if that's ever down.
    rpcUrls: ["https://rpc.unlock-protocol.com/8453", "https://mainnet.base.org"],
    // Verified 2026-08-28 against unlock-protocol/unlock, packages/networks/src/networks/base.ts
    // (unlockAddress field). Matches @unlock-protocol/networks@0.0.25, which is still current on
    // npm as of this date, so no divergence between the published package and the repo was found.
    unlockAddress: "0xd0b14797b9D08493392865647384974470202A78",
    subgraph: "https://subgraph.unlock-protocol.com/8453",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  },
};

/**
 * Resolves a network by name. An RPC override for network "x" can be supplied via the
 * UNLOCK_MCP_RPC_URL_X environment variable (e.g. UNLOCK_MCP_RPC_URL_BASE) — it's tried
 * first, ahead of the built-in defaults, which remain as fallbacks. A subgraph override
 * can be supplied the same way via UNLOCK_MCP_SUBGRAPH_URL_X — since there's only ever
 * one subgraph endpoint (no fallback chain), it replaces the default outright.
 */
export function getNetwork(name: string): NetworkConfig {
  const key = name.toLowerCase();
  const network = networks[key];
  if (!network) {
    const supported = Object.keys(networks).join(", ");
    throw new Error(`Unknown network "${name}". Supported networks: ${supported}`);
  }
  const rpcOverride = process.env[`UNLOCK_MCP_RPC_URL_${key.toUpperCase()}`]?.trim();
  const subgraphOverride = process.env[`UNLOCK_MCP_SUBGRAPH_URL_${key.toUpperCase()}`]?.trim();
  return {
    ...network,
    rpcUrls: rpcOverride ? [rpcOverride, ...network.rpcUrls] : network.rpcUrls,
    subgraph: subgraphOverride || network.subgraph,
  };
}

export function toViemChain(network: NetworkConfig): Chain {
  return {
    id: network.id,
    name: network.name,
    nativeCurrency: network.nativeCurrency,
    rpcUrls: {
      default: { http: network.rpcUrls },
    },
  };
}
