function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function escapeControlCharsInsideStrings(raw: string): string {
    let output = "";
    let inString = false;
    let escaped = false;

    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];

        if (inString) {
            if (escaped) {
                output += ch;
                escaped = false;
                continue;
            }

            if (ch === "\\") {
                output += ch;
                escaped = true;
                continue;
            }

            if (ch === "\"") {
                output += ch;
                inString = false;
                continue;
            }

            if (ch === "\n") {
                output += "\\n";
                continue;
            }
            if (ch === "\r") {
                output += "\\r";
                continue;
            }
            if (ch === "\t") {
                output += "\\t";
                continue;
            }
        }

        output += ch;
        if (ch === "\"") {
            inString = true;
        }
    }

    return output;
}

export function extractFirstBalancedObject(raw: string): string | null {
    const start = raw.indexOf("{");
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < raw.length; i++) {
        const ch = raw[i];

        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === "\\") {
                escaped = true;
                continue;
            }
            if (ch === "\"") {
                inString = false;
            }
            continue;
        }

        if (ch === "\"") {
            inString = true;
            continue;
        }

        if (ch === "{") {
            depth += 1;
            continue;
        }
        if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
                return raw.slice(start, i + 1);
            }
        }
    }

    return null;
}

export function extractJsonBlock(rawContent: string): string | null {
    const clean = rawContent.trim();
    if (!clean.startsWith("{") && !clean.startsWith("```")) {
        return null;
    }

    if (clean.startsWith("{") && clean.endsWith("}")) {
        return clean;
    }

    const markdownMatch = clean.match(/```json\s*([\s\S]*?)\s*```/i);
    if (markdownMatch?.[1]) {
        return markdownMatch[1].trim();
    }

    const fencedMatch = clean.match(/```\s*([\s\S]*?)\s*```/i);
    if (fencedMatch?.[1]) {
        return fencedMatch[1].trim();
    }

    return extractFirstBalancedObject(clean);
}

function parseJsonCandidate<T>(raw: string): T | null {
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

export function parseJsonWithRecovery<T>(raw: string): T | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const direct = parseJsonCandidate<T>(trimmed);
    if (direct !== null) return direct;

    const escaped = parseJsonCandidate<T>(escapeControlCharsInsideStrings(trimmed));
    if (escaped !== null) return escaped;

    const firstObject = extractFirstBalancedObject(trimmed);
    if (!firstObject) return null;

    const firstDirect = parseJsonCandidate<T>(firstObject);
    if (firstDirect !== null) return firstDirect;

    return parseJsonCandidate<T>(escapeControlCharsInsideStrings(firstObject));
}

export interface ParsedToolArguments {
    ok: boolean;
    args: Record<string, unknown>;
    error?: string;
}

export function parseToolArguments(rawArguments: unknown): ParsedToolArguments {
    if (rawArguments === undefined || rawArguments === null) {
        return { ok: true, args: {} };
    }

    if (isRecord(rawArguments)) {
        return { ok: true, args: rawArguments };
    }

    if (typeof rawArguments !== "string") {
        return {
            ok: false,
            args: {},
            error: "Tool arguments must be a JSON object.",
        };
    }

    if (!rawArguments.trim()) {
        return { ok: true, args: {} };
    }

    const parsed = parseJsonWithRecovery<unknown>(rawArguments);
    if (!isRecord(parsed)) {
        return {
            ok: false,
            args: {},
            error: "Tool arguments must decode to a JSON object.",
        };
    }

    return { ok: true, args: parsed };
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`;
    }
    if (!isRecord(value)) {
        return JSON.stringify(value);
    }

    const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
    const serializedEntries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${serializedEntries.join(",")}}`;
}

export function createToolCallSignature(toolId: string, args: Record<string, unknown>): string {
    return `${toolId}:${stableStringify(args)}`;
}
