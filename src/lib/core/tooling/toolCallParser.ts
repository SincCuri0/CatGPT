import { extractJsonBlock, parseJsonWithRecovery, parseToolArguments } from "./toolArgParsing";

export interface ParsedToolCall {
    tool: string;
    args: Record<string, unknown>;
}

function parseSingleToolCallPayload(payload: unknown): ParsedToolCall | null {
    if (!payload || typeof payload !== "object") return null;
    const candidate = payload as { tool?: unknown; args?: unknown };
    if (typeof candidate.tool !== "string") return null;

    const parsedArgs = parseToolArguments(candidate.args);
    return {
        tool: candidate.tool,
        args: parsedArgs.ok ? parsedArgs.args : {},
    };
}

function parsePayloadToToolCalls(payload: unknown): ParsedToolCall[] {
    if (!payload || typeof payload !== "object") return [];

    const parsedSingle = parseSingleToolCallPayload(payload);
    if (parsedSingle) return [parsedSingle];

    const record = payload as { tool_calls?: unknown; calls?: unknown };
    const collections: unknown[] = [];
    if (Array.isArray(record.tool_calls)) {
        collections.push(...record.tool_calls);
    }
    if (Array.isArray(record.calls)) {
        collections.push(...record.calls);
    }

    const parsed: ParsedToolCall[] = [];
    for (const entry of collections) {
        const nested = entry as { tool?: unknown; args?: unknown; function?: unknown; name?: unknown; arguments?: unknown };
        const fromDirect = parseSingleToolCallPayload(entry);
        if (fromDirect) {
            parsed.push(fromDirect);
            continue;
        }

        const functionPayload = nested.function && typeof nested.function === "object"
            ? nested.function as { name?: unknown; arguments?: unknown }
            : null;

        const toolName = typeof nested.tool === "string"
            ? nested.tool
            : (typeof nested.name === "string"
                ? nested.name
                : (typeof functionPayload?.name === "string" ? functionPayload.name : ""));
        if (!toolName) continue;

        let args: Record<string, unknown> = {};
        const rawArgs = nested.args
            ?? nested.arguments
            ?? functionPayload?.arguments;
        const parsedArgs = parseToolArguments(rawArgs);
        if (parsedArgs.ok) {
            args = parsedArgs.args;
        }

        parsed.push({ tool: toolName, args });
    }

    return parsed;
}

export function parseToolCallsFromText(rawContent: string): ParsedToolCall[] {
    const jsonText = extractJsonBlock(rawContent);
    if (!jsonText) return [];

    const payload = parseJsonWithRecovery<unknown>(jsonText);
    if (!payload) return [];
    const parsed = parsePayloadToToolCalls(payload);
    if (parsed.length > 0) {
        return parsed;
    }

    return [];
}

export function parseToolCallFromText(rawContent: string): ParsedToolCall | null {
    const parsed = parseToolCallsFromText(rawContent);
    return parsed[0] ?? null;
}

export function looksLikeToolCallJson(rawContent: string): boolean {
    const trimmed = rawContent.trim();
    if (!trimmed) return false;

    const isJsonLike = trimmed.startsWith("{")
        || trimmed.startsWith("```json")
        || trimmed.startsWith("```");
    if (!isJsonLike) return false;

    const normalized = trimmed.toLowerCase();
    return normalized.includes("\"tool\"")
        && normalized.includes("\"args\"");
}
