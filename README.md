# unlock-mcp

[![npm](https://img.shields.io/npm/v/unlock-mcp)](https://www.npmjs.com/package/unlock-mcp)

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

## Development

```sh
npm install
npm run build
npm test
```
