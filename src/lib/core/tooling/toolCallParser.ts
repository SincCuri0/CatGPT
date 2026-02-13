export interface ParsedToolCall {
    tool: string;
    args: Record<string, unknown>;
}

function extractJson(raw: string): string | null {
    const clean = raw.trim();
    if (clean.startsWith("{") && clean.endsWith("}")) {
        return clean;
    }

    const markdownMatch = clean.match(/```json\s*([\s\S]*?)\s*```/i);
    if (markdownMatch?.[1]) {
        return markdownMatch[1].trim();
    }

    const inlineMatch = clean.match(/({[\s\S]*?"tool"\s*:\s*"[^"]+"[\s\S]*?})/);
    return inlineMatch?.[1] ?? null;
}

export function parseToolCallFromText(rawContent: string): ParsedToolCall | null {
    const jsonText = extractJson(rawContent);
    if (!jsonText) return null;

    try {
        const payload = JSON.parse(jsonText) as { tool?: unknown; args?: unknown };
        if (typeof payload.tool !== "string") return null;

        return {
            tool: payload.tool,
            args: payload.args && typeof payload.args === "object" ? payload.args as Record<string, unknown> : {},
        };
    } catch {
        return null;
    }
}
