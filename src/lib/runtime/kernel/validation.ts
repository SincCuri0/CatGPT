import type { AgentConfig } from "@/lib/core/Agent";

export function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isAgentConfigLike(value: unknown): value is AgentConfig {
    if (!isRecord(value)) return false;
    return (
        typeof value.name === "string"
        && typeof value.role === "string"
        && typeof value.systemPrompt === "string"
    );
}

export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return "Unknown error";
}

export function toPreview(value: string, maxChars = 220): string {
    const collapsed = value.replace(/\s+/g, " ").trim();
    if (!collapsed) return "(empty)";
    return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1).trimEnd()}...` : collapsed;
}

