import { Tool } from "../types";
import { LLMToolDefinition } from "@/lib/llm/types";

const NAME_SANITIZE_REGEX = /[^a-zA-Z0-9_]/g;
const VALID_TOOL_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const MAX_TOOL_NAME_LENGTH = 64;
const DEFAULT_INPUT_SCHEMA = {
    type: "object" as const,
    properties: {},
    required: [],
    additionalProperties: true,
};

function sanitizeToolName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return "tool";
    const sanitizedBase = trimmed
        .replace(NAME_SANITIZE_REGEX, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    const withFallback = sanitizedBase || "tool";
    const withValidPrefix = /^[a-zA-Z_]/.test(withFallback)
        ? withFallback
        : `tool_${withFallback}`;
    return withValidPrefix.slice(0, MAX_TOOL_NAME_LENGTH);
}

function isValidProviderToolName(name: string): boolean {
    return VALID_TOOL_NAME_REGEX.test(name);
}

function buildUniqueProviderToolName(baseName: string, usedNames: Set<string>): string {
    let attempt = 1;
    while (attempt < 10_000) {
        const suffix = attempt === 1 ? "" : `_${attempt}`;
        const maxBaseLength = Math.max(1, MAX_TOOL_NAME_LENGTH - suffix.length);
        const normalizedBase = sanitizeToolName(baseName).slice(0, maxBaseLength) || "tool";
        const candidate = `${normalizedBase}${suffix}`;
        if (!usedNames.has(candidate) && isValidProviderToolName(candidate)) {
            return candidate;
        }
        attempt += 1;
    }
    return `tool_${Date.now()}`.slice(0, MAX_TOOL_NAME_LENGTH);
}

export interface ProviderToolManifest {
    providerTools: LLMToolDefinition[];
    resolveToolId: (providerToolName: string) => string | null;
}

export function buildProviderToolManifest(
    tools: Tool[],
): ProviderToolManifest {
    const nameToId = new Map<string, string>();
    const usedNames = new Set<string>();
    const providerTools: LLMToolDefinition[] = [];

    for (const tool of tools) {
        const baseName = sanitizeToolName(tool.name || tool.id || "tool");
        const providerName = buildUniqueProviderToolName(baseName, usedNames);
        if (!isValidProviderToolName(providerName)) {
            console.warn("Dropped tool from provider manifest because a valid function name could not be generated.", {
                toolId: tool.id,
                toolName: tool.name,
                providerName,
            });
            continue;
        }

        const normalizedId = typeof tool.id === "string" && tool.id.trim().length > 0
            ? tool.id
            : providerName;
        usedNames.add(providerName);
        nameToId.set(providerName, normalizedId);

        providerTools.push({
            id: normalizedId,
            name: providerName,
            description: typeof tool.description === "string" && tool.description.trim().length > 0
                ? tool.description
                : `Tool ${providerName}`,
            inputSchema: tool.inputSchema ?? DEFAULT_INPUT_SCHEMA,
        } satisfies LLMToolDefinition);
    }

    return {
        providerTools,
        resolveToolId: (providerToolName: string) => {
            if (nameToId.has(providerToolName)) {
                return nameToId.get(providerToolName) ?? null;
            }

            const byId = tools.find((tool) => tool.id === providerToolName || tool.name === providerToolName);
            return byId ? byId.id : null;
        },
    };
}
