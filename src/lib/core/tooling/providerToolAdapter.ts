import { Tool } from "../types";
import { LLMToolDefinition } from "@/lib/llm/types";

const NAME_SANITIZE_REGEX = /[^a-zA-Z0-9_-]/g;
const DEFAULT_INPUT_SCHEMA = {
    type: "object" as const,
    properties: {},
    required: [],
    additionalProperties: true,
};

function sanitizeToolName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return "tool";
    return trimmed.replace(NAME_SANITIZE_REGEX, "_").slice(0, 64);
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

    const providerTools = tools.map((tool) => {
        const baseName = sanitizeToolName(tool.name || tool.id);
        let providerName = baseName;
        let suffix = 2;
        while (usedNames.has(providerName)) {
            providerName = `${baseName}_${suffix}`;
            suffix += 1;
        }
        usedNames.add(providerName);
        nameToId.set(providerName, tool.id);

        return {
            id: tool.id,
            name: providerName,
            description: tool.description,
            inputSchema: tool.inputSchema ?? tool.parameters ?? DEFAULT_INPUT_SCHEMA,
        } satisfies LLMToolDefinition;
    });

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
