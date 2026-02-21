import { Tool, ToolResult } from "../../core/types";

const DUCKDUCKGO_API = "https://api.duckduckgo.com/";
const SEARCH_TIMEOUT_MS = 10_000;

interface DuckDuckGoTopic {
    Text?: string;
    FirstURL?: string;
    Topics?: DuckDuckGoTopic[];
}

function flattenTopics(topics: DuckDuckGoTopic[] | undefined, output: DuckDuckGoTopic[] = []): DuckDuckGoTopic[] {
    if (!Array.isArray(topics)) return output;
    for (const topic of topics) {
        if (!topic || typeof topic !== "object") continue;
        if (typeof topic.Text === "string" && topic.Text.trim().length > 0) {
            output.push(topic);
        }
        if (Array.isArray(topic.Topics)) {
            flattenTopics(topic.Topics, output);
        }
    }
    return output;
}

function normalizeResultLine(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

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

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

        try {
            const url = `${DUCKDUCKGO_API}?q=${encodeURIComponent(query.trim())}&format=json&no_html=1&skip_disambig=1`;
            const response = await fetch(url, {
                method: "GET",
                signal: controller.signal,
                headers: {
                    Accept: "application/json",
                },
            });

            if (!response.ok) {
                const details = `Web search request failed with status ${response.status}.`;
                return {
                    ok: false,
                    error: details,
                    output: details,
                    artifacts: [{
                        kind: "web",
                        label: "search-query",
                        operation: "search",
                        metadata: { query, provider: "duckduckgo", status: response.status },
                    }],
                    checks: [
                        { id: "query_non_empty", ok: true, description: "Search query was provided." },
                        { id: "live_search_ok", ok: false, description: "Live web search request failed." },
                    ],
                } satisfies ToolResult;
            }

            const payload = await response.json() as Record<string, unknown>;
            const abstractText = typeof payload.AbstractText === "string" ? payload.AbstractText.trim() : "";
            const abstractUrl = typeof payload.AbstractURL === "string" ? payload.AbstractURL.trim() : "";
            const heading = typeof payload.Heading === "string" ? payload.Heading.trim() : "";
            const answer = typeof payload.Answer === "string" ? payload.Answer.trim() : "";
            const relatedTopics = flattenTopics(payload.RelatedTopics as DuckDuckGoTopic[] | undefined);

            const lines: string[] = [];
            if (heading || abstractText) {
                const headingPrefix = heading ? `${heading}: ` : "";
                const urlSuffix = abstractUrl ? ` (${abstractUrl})` : "";
                const text = normalizeResultLine(`${headingPrefix}${abstractText || answer}${urlSuffix}`);
                if (text) lines.push(text);
            } else if (answer) {
                lines.push(normalizeResultLine(answer));
            }

            for (const topic of relatedTopics.slice(0, 6)) {
                const text = typeof topic.Text === "string" ? topic.Text.trim() : "";
                if (!text) continue;
                const urlSuffix = typeof topic.FirstURL === "string" && topic.FirstURL.trim().length > 0
                    ? ` (${topic.FirstURL.trim()})`
                    : "";
                lines.push(normalizeResultLine(`${text}${urlSuffix}`));
            }

            const uniqueLines = Array.from(new Set(lines)).slice(0, 6);
            const output = uniqueLines.length > 0
                ? [
                    `Live web results for "${query.trim()}":`,
                    ...uniqueLines.map((line, index) => `${index + 1}. ${line}`),
                ].join("\n")
                : `No direct live results found for "${query.trim()}".`;

            return {
                ok: true,
                output,
                artifacts: [{
                    kind: "web",
                    label: "search-query",
                    operation: "search",
                    metadata: {
                        query,
                        provider: "duckduckgo",
                        resultCount: uniqueLines.length,
                    },
                }],
                checks: [
                    { id: "query_non_empty", ok: true, description: "Search query was provided." },
                    { id: "live_search_ok", ok: true, description: "Live web search completed." },
                ],
            } satisfies ToolResult;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            const details = `Live web search failed: ${message}`;
            return {
                ok: false,
                error: details,
                output: details,
                artifacts: [{
                    kind: "web",
                    label: "search-query",
                    operation: "search",
                    metadata: {
                        query,
                        provider: "duckduckgo",
                    },
                }],
                checks: [
                    { id: "query_non_empty", ok: true, description: "Search query was provided." },
                    { id: "live_search_ok", ok: false, description: "Live web search failed." },
                ],
            } satisfies ToolResult;
        } finally {
            clearTimeout(timer);
        }
    }
};
