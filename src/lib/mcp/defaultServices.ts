import type { McpServiceConfig } from "./types";

// Default local MCP services intended to run directly on the user's machine.
// These are enabled by default and can be adjusted via user settings.
export const DEFAULT_LOCAL_MCP_SERVICES: McpServiceConfig[] = [
    {
        id: "mcp-filesystem",
        name: "Filesystem MCP",
        description: "File operations exposed via MCP (scoped to current workspace).",
        enabled: true,
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
        timeoutMs: 12_000,
    },
    {
        id: "mcp-sequential-thinking",
        name: "Sequential Thinking MCP",
        description: "Structured reasoning/planning tools via MCP.",
        enabled: true,
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
        timeoutMs: 12_000,
    },
];
