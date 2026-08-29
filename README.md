<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" width="96" alt="unlock-mcp">
  </picture>
</p>

# unlock-mcp

[![npm](https://img.shields.io/npm/v/unlock-mcp)](https://www.npmjs.com/package/unlock-mcp)
[![unlock-mcp MCP server](https://glama.ai/mcp/servers/wkalidev/unlock-mcp/badges/score.svg)](https://glama.ai/mcp/servers/wkalidev/unlock-mcp)

Read-only MCP server exposing [Unlock Protocol](https://unlock-protocol.com/) on-chain
state. No private keys, no signing, no write calls — every tool only reads from the
chain.

## Install

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "unlock": {
      "command": "npx",
      "args": ["-y", "unlock-mcp"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add unlock -- npx -y unlock-mcp
```

### Local development

If you're working on the server itself, point either of the above at a local checkout
instead:

```json
{
  "mcpServers": {
    "unlock": {
      "command": "node",
      "args": ["/absolute/path/to/unlock-mcp/dist/index.js"]
    }
  }
}
```

## Tools

### `unlock_check_membership`

Checks whether a wallet holds a valid (non-expired) key for an Unlock Protocol lock.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `lockAddress` | `0x` address | yes | The PublicLock contract to check |
| `walletAddress` | `0x` address | yes | The wallet to check for a key |
| `network` | string | no | Defaults to `"base"` |

Returns whether the wallet holds a valid key, and if so its expiration (ISO timestamp
and a relative form like "in 2 years"), the tokenId, the lock name, and the network.

`keyExpirationTimestampFor` changed signature across PublicLock versions — locks below
`publicLockVersion` 10 take a key owner address, version 10 and up take a tokenId. The
tool reads `publicLockVersion()` and calls whichever form the lock actually implements.

Distinct, plain-language results are returned for: a lock address that isn't a
contract, a contract that isn't a PublicLock, a wallet with no key, and a wallet with
an expired or valid key. These are all normal results, not errors — a definitive
answer about the chain isn't a tool failure. The tool only reports an error for cases
it genuinely can't answer: an unreachable/rate-limited RPC endpoint, or malformed
input. No raw RPC error or revert reason is ever passed through.

Every value is read live from the chain at call time — including `name()` — so it
reflects current on-chain state, not a block explorer's indexed snapshot (a lock's
name is only set once at deploy time in most explorer UIs, but can change on-chain
afterward; this tool always reads the current value).

### `unlock_get_lock`

Reads a lock's public shape directly from the chain via RPC (not the subgraph — this
is point-in-time state, and the RPC path already exists).

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `lockAddress` | `0x` address | yes | The PublicLock contract to read |
| `network` | string | no | Defaults to `"base"` |

Returns name, symbol, address, network, PublicLock version, key price (amount, raw
value, and currency — the token's own symbol/decimals for an ERC-20, or the chain's
native currency if the lock's `tokenAddress()` is the zero address), expiration
duration in both seconds and human-readable form, max number of keys, and total keys
sold (`totalSupply()`, a running counter of every key ever created — not the current
valid supply).

`expirationDuration` and `maxNumberOfKeys` each use a max-uint256 sentinel for
"unlimited" (never-expiring keys, or no cap on keys respectively) — the tool reports
those explicitly as `unlimited: true` rather than surfacing the raw sentinel as a
number.

Lock managers are deliberately **not** included: PublicLock exposes no enumerable
getter for that role (it uses a plain OpenZeppelin AccessControl role, not
AccessControlEnumerable) — only `isLockManager(address)`, a point check against an
address you'd already have to know. Getting the actual list would mean either
replaying `RoleGranted`/`RoleRevoked` logs from deployment (not a cheap RPC read) or
asking the subgraph, which this tool intentionally avoids so it stays pure on-chain
state. Same three classification results as `unlock_check_membership` apply here for
a bad address: not a contract, not a PublicLock, or a working lock.

### `unlock_list_keys`

Lists every key a wallet holds across locks on a network, via Unlock's subgraph —
enumerating a wallet's keys across all locks isn't something RPC can do without
already knowing which locks to look at.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `walletAddress` | `0x` address | yes | The wallet to list keys for |
| `network` | string | no | Defaults to `"base"` |
| `includeExpired` | boolean | no | Include expired/cancelled keys too (default `false`, i.e. currently-valid keys only) |

Returns, per key: lock address, lock name, tokenId, expiration (ISO timestamp, or
`"never"` for a lifetime key), and whether it's currently valid. Results are sorted by
expiration descending and capped at 100, with a note in the response if the cap was
hit. A wallet holding no keys is a normal empty result, not an error.

## Networks

Chains are configured as data in `src/networks.ts` — adding one is a new object, not a
code change. Only Base is configured today.

The Base Unlock factory address was cross-checked against
[`unlock-protocol/unlock`](https://github.com/unlock-protocol/unlock)
(`packages/networks/src/networks/base.ts`) directly, since `@unlock-protocol/networks`
on npm hasn't been republished since `0.0.25` (Dec 2024). As of this check, the two
still agree — no divergence found.

### RPC endpoints

Each network has a primary RPC and one or more fallbacks, tried in order — a failure
on one (timeout, connection error, rate limit) automatically retries on the next. Base
defaults to Unlock's own public RPC (`rpc.unlock-protocol.com`), falling back to the
public Base RPC (`mainnet.base.org`).

To override the endpoints tried for a given network, set
`UNLOCK_MCP_RPC_URL_<NETWORK>` (uppercased network name), e.g.:

```sh
UNLOCK_MCP_RPC_URL_BASE=https://your-rpc.example.com
```

The override is tried first; the built-in defaults remain as fallbacks behind it.

### Subgraph endpoint

`unlock_list_keys` reads from Unlock's public subgraph, one endpoint per network
(no fallback chain, since there's only one). To override it for a given network, set
`UNLOCK_MCP_SUBGRAPH_URL_<NETWORK>` (uppercased network name), e.g.:

```sh
UNLOCK_MCP_SUBGRAPH_URL_BASE=https://your-subgraph.example.com
```

## Development

```sh
npm install
npm run build
npm test
```
