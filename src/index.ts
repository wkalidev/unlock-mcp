#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  MembershipCheckError,
  checkMembership,
  checkMembershipInputShape,
  formatMembershipResult,
} from "./tools/checkMembership.js";
import { GetLockError, formatGetLockResult, getLock, getLockInputShape } from "./tools/getLock.js";
import { ListKeysError, formatListKeysResult, listKeys, listKeysInputShape } from "./tools/listKeys.js";

const server = new McpServer({
  name: "unlock-mcp",
  version: "0.1.0",
});

server.registerTool(
  "unlock_check_membership",
  {
    title: "Check Unlock Protocol membership",
    description:
      "Check whether a wallet holds a valid (non-expired) key for a specific Unlock Protocol lock, read-only. " +
      "Returns status (valid, expired, no_key, not_a_contract, or not_a_lock), lock name, tokenId, and expiration. " +
      "Use this when you already know the lock address to check; use unlock_list_keys instead when you need " +
      "every lock a wallet holds and don't know the addresses up front. " +
      "The verdict normally comes from the lock's own getHasValidKey; on locks that predate it, the call falls " +
      "back to comparing the read expiration to the local clock and reports verdictSource: \"local_clock\" (absent " +
      "when the contract answered). Set requireContractVerdict to fail instead of accepting that fallback.",
    inputSchema: checkMembershipInputShape,
  },
  async (input) => {
    try {
      const result = await checkMembership(input);
      return {
        content: [{ type: "text", text: formatMembershipResult(result) }],
      };
    } catch (err) {
      const message = err instanceof MembershipCheckError ? err.message : "Unexpected error checking membership.";
      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "unlock_get_lock",
  {
    title: "Get Unlock Protocol lock details",
    description:
      "Read an Unlock Protocol lock's public shape from the chain, read-only: name, symbol, key price/currency, expiration duration, max keys, and total keys sold.",
    inputSchema: getLockInputShape,
  },
  async (input) => {
    try {
      const result = await getLock(input);
      return {
        content: [{ type: "text", text: formatGetLockResult(result) }],
      };
    } catch (err) {
      const message = err instanceof GetLockError ? err.message : "Unexpected error reading the lock.";
      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "unlock_list_keys",
  {
    title: "List Unlock Protocol keys held by a wallet",
    description:
      "List every Unlock Protocol key a wallet holds across locks on a network, via the Unlock subgraph, read-only. " +
      "Returns each key's lock address and name, tokenId, expiration, and validity, sorted by expiration descending " +
      "and capped at 100 results with a truncation flag. Use this when you need every membership a wallet holds " +
      "and don't know the lock addresses up front; use unlock_check_membership instead when you already know " +
      "which lock to check.",
    inputSchema: listKeysInputShape,
  },
  async (input) => {
    try {
      const result = await listKeys(input);
      return {
        content: [{ type: "text", text: formatListKeysResult(result) }],
      };
    } catch (err) {
      const message = err instanceof ListKeysError ? err.message : "Unexpected error listing keys.";
      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error starting unlock-mcp:", err);
  process.exit(1);
});
