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
      "Check whether a wallet holds a valid (non-expired) key for an Unlock Protocol lock, read-only.",
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
      "List every Unlock Protocol key a wallet holds across locks on a network, via the Unlock subgraph, read-only.",
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
