import { Tool, ToolResult } from "../../core/types";

// PRO TIP: In a real app, integrate Tavily or SerpAPI here.
// For the open source version, we can let users provide their own key in Settings 
// or implement a lightweight scraper.

export const WebSearchTool: Tool = {
    id: "web_search",
    name: "search_internet",
    description: "Search the internet for information.",
    inputSchema: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "The search query."
            }
        },
        required: ["query"]
    },
    execute: async (args: unknown) => {
        const query = typeof (args as { query?: unknown })?.query === "string"
            ? (args as { query: string }).query
            : "";
        if (!query.trim()) {
            return {
                ok: false,
                error: "Web search query must be a non-empty string.",
                output: "Web search query must be a non-empty string.",
                artifacts: [],
                checks: [{ id: "query_non_empty", ok: false, description: "Search query is required." }],
            } satisfies ToolResult;
        }

        // Placeholder implementation
        // Ideally, check for an API key in environment or settings
        console.warn("Web Search Tool called with:", query);
        return {
            ok: true,
            output: `[Mock Search Result] Found several articles about "${query}". 
    1. Wikipedia: ${query} is a fascinating topic...
    2. News: Recent developments in ${query}...
    (Note: Real web search requires an API key configuration, e.g., Tavily)`,
            artifacts: [{
                kind: "web",
                label: "search-query",
                operation: "search",
                metadata: { query },
            }],
            checks: [{ id: "query_non_empty", ok: true, description: "Search query was provided." }],
        } satisfies ToolResult;
    }
};
