import { v4 as uuidv4 } from "uuid";
import { providerRegistry } from "../llm/ProviderRegistry";
import { LLMClient } from "../llm/types";
import { Message, Tool } from "./types";
import { buildProviderToolManifest } from "./tooling/providerToolAdapter";
import { parseToolCallFromText } from "./tooling/toolCallParser";
import { validateToolArgs } from "./tooling/toolValidation";

export type AgentStyle = "assistant" | "character" | "expert" | "custom";
export type AgentApiKeys = string | Record<string, string | null | undefined> | null;

const MAX_TOOL_TURNS = 5;
const NATIVE_TOOL_PROVIDER_IDS = new Set(["openai", "groq"]);

export interface AgentConfig {
    id?: string;
    name: string;
    role: string;
    description?: string;
    style?: AgentStyle;
    systemPrompt: string;
    voiceId?: string; // Edge TTS voice ID
    provider?: string; // LLM Provider ID (e.g., "groq", "openai")
    model?: string; // Model ID specific to the provider
    tools?: string[]; // IDs of enabled tools
}

export class Agent {
    public id: string;
    public name: string;
    public role: string;
    public systemPrompt: string;
    public voiceId: string;
    public provider: string;
    public model: string;
    public tools: string[];

    constructor(config: AgentConfig) {
        this.id = config.id || uuidv4();
        this.name = config.name;
        this.role = config.role;
        this.systemPrompt = config.systemPrompt;
        this.voiceId = config.voiceId || "en-US-ChristopherNeural";
        this.provider = config.provider || "groq";
        this.model = config.model || "llama-3.3-70b-versatile";
        this.tools = config.tools || [];
    }

    private resolveApiKey(apiKeys: AgentApiKeys): string | null {
        if (!apiKeys) return null;
        if (typeof apiKeys === "string") {
            return this.provider === "groq" ? apiKeys : null;
        }
        return apiKeys[this.provider] || null;
    }

    public getLLMClient(apiKeys: AgentApiKeys): LLMClient {
        const apiKey = this.resolveApiKey(apiKeys);
        if (!apiKey) {
            throw new Error(`API key missing for provider '${this.provider}' (agent: ${this.name}).`);
        }
        return providerRegistry.createClient(this.provider, apiKey, this.model);
    }

    private getSystemMessage(enabledTools: Tool[]): string {
        const basePrompt = `You are ${this.name}, a ${this.role}.

Personality/Instructions:
${this.systemPrompt}

Start your response directly. Do not prefix with "System:" or "Agent:".`;

        if (enabledTools.length === 0) {
            return basePrompt;
        }

        const toolDescriptions = enabledTools
            .map((tool) => (
                `- Tool: ${tool.name} (ID: ${tool.id})\n  Description: ${tool.description}\n  InputSchema: ${JSON.stringify(tool.inputSchema)}`
            ))
            .join("\n\n");

        return `${basePrompt}

## AVAILABLE TOOLS
Use tools when they increase correctness.
If native function-calling is unavailable for this model, call tools by replying with only this JSON object:
\`\`\`json
{ "tool": "tool_id", "args": { ... } }
\`\`\`

Tools List:
${toolDescriptions}

If no tool is needed, answer normally.`;
    }

    private async executeTool(
        tool: Tool,
        args: Record<string, unknown>,
    ): Promise<string> {
        const validation = validateToolArgs(tool.inputSchema!, args);
        if (!validation.ok) {
            return `Tool validation failed for '${tool.name}': ${validation.errors.join(" ")}`;
        }

        try {
            return await tool.execute(args, {
                agentId: this.id,
                agentName: this.name,
                providerId: this.provider,
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return `Tool execution failed for '${tool.name}': ${message}`;
        }
    }

    async process(history: Message[], apiKeys: AgentApiKeys, availableTools: Tool[] = []): Promise<Message> {
        const llm = this.getLLMClient(apiKeys);
        const enabledTools = availableTools.filter(
            (tool) => this.tools.includes(tool.id) || this.tools.includes(tool.name),
        );

        const { providerTools, resolveToolId } = buildProviderToolManifest(enabledTools);

        const currentHistory = [
            { role: "system" as const, content: this.getSystemMessage(enabledTools) },
            ...history
                .filter((m) => m.role === "user" || m.role === "assistant")
                .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        ];

        for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
            const response = await llm.chat(currentHistory, {
                max_tokens: 4096,
                tools: providerTools,
                toolChoice: providerTools.length > 0 ? "auto" : undefined,
            });

            const assistantContent = response.content || "";
            const providerToolCall = response.toolCalls?.[0];

            if (providerToolCall) {
                const toolId = resolveToolId(providerToolCall.name);
                const tool = toolId ? enabledTools.find((candidate) => candidate.id === toolId) : null;

                if (!tool) {
                    currentHistory.push({ role: "assistant", content: assistantContent });
                    currentHistory.push({ role: "system", content: `Error: Tool '${providerToolCall.name}' not found.` });
                    continue;
                }

                let parsedArgs: Record<string, unknown> = {};
                try {
                    parsedArgs = providerToolCall.argumentsText
                        ? JSON.parse(providerToolCall.argumentsText) as Record<string, unknown>
                        : {};
                } catch {
                    currentHistory.push({ role: "assistant", content: assistantContent });
                    currentHistory.push({ role: "system", content: `Error: Invalid tool arguments for '${tool.name}'.` });
                    continue;
                }

                currentHistory.push({ role: "assistant", content: assistantContent || `[Tool Call] ${tool.name}` });
                const result = await this.executeTool(tool, parsedArgs);
                currentHistory.push({ role: "user", content: `[Tool Result for ${tool.name}]:\n${result}` });
                continue;
            }

            const supportsNativeTools = NATIVE_TOOL_PROVIDER_IDS.has(this.provider);
            if (!supportsNativeTools && enabledTools.length > 0) {
                const parsedToolCall = parseToolCallFromText(assistantContent);
                if (parsedToolCall) {
                    const tool = enabledTools.find(
                        (candidate) => candidate.id === parsedToolCall.tool || candidate.name === parsedToolCall.tool,
                    );

                    if (!tool) {
                        currentHistory.push({ role: "assistant", content: assistantContent });
                        currentHistory.push({ role: "system", content: `Error: Tool '${parsedToolCall.tool}' not found.` });
                        continue;
                    }

                    currentHistory.push({ role: "assistant", content: assistantContent });
                    const result = await this.executeTool(tool, parsedToolCall.args);
                    currentHistory.push({ role: "user", content: `[Tool Result for ${tool.name}]:\n${result}` });
                    continue;
                }
            }

            return {
                id: uuidv4(),
                role: "assistant",
                name: this.name,
                content: assistantContent,
                timestamp: Date.now(),
            };
        }

        return {
            id: uuidv4(),
            role: "assistant",
            name: this.name,
            content: "Error: Task limit exceeded (too many tool calls).",
            timestamp: Date.now(),
        };
    }
}
