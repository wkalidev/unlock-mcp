#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  MembershipCheckError,
  checkMembership,
  checkMembershipInputShape,
  formatMembershipResult,
} from "./tools/checkMembership.js";

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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error starting unlock-mcp:", err);
  process.exit(1);
});
