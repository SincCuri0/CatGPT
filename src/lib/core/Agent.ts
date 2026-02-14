import { v4 as uuidv4 } from "uuid";
import { providerRegistry } from "../llm/ProviderRegistry";
import type { LLMClient, LLMMessage, LLMToolCall, ReasoningEffort } from "../llm/types";
import { DEFAULT_REASONING_EFFORT, PROVIDERS } from "../llm/constants";
import { isKnownDeprecatedModel, isModelChatCapable, supportsReasoningEffort, supportsToolUse } from "../llm/modelCatalog";
import { Message, Tool, ToolExecutionContext, ToolResult } from "./types";
import { buildProviderToolManifest } from "./tooling/providerToolAdapter";
import { createToolCallSignature, parseToolArguments } from "./tooling/toolArgParsing";
import { validateToolArgs } from "./tooling/toolValidation";

export type AgentStyle = "assistant" | "character" | "expert" | "custom";
export type AccessPermissionMode = "ask_always" | "full_access";
export type AgentApiKeys = string | Record<string, string | null | undefined> | null;

const MAX_TOOL_TURNS = 24;
const MAX_IDENTICAL_TOOL_CALLS = 2;
const PRIVILEGED_TOOL_IDS = new Set(["fs_write", "shell_execute", "write_file", "execute_command"]);
const MCP_ALL_TOOL_ID = "mcp_all";

function isToolResultError(result: ToolResult): boolean {
    return !result.ok;
}

function formatToolResultForPrompt(result: ToolResult): string {
    const lines: string[] = [];

    if (result.output && result.output.trim().length > 0) {
        lines.push(result.output.trim());
    }

    if (!result.ok) {
        lines.unshift(`Error: ${result.error || "Tool execution failed."}`);
    }

    if (result.checks.length > 0) {
        const summary = result.checks
            .map((check) => `${check.id}=${check.ok ? "ok" : "fail"}`)
            .join(", ");
        lines.push(`[Checks] ${summary}`);
    }

    if (result.artifacts.length > 0) {
        const summary = result.artifacts
            .map((artifact) => {
                const operation = artifact.operation ? `:${artifact.operation}` : "";
                const path = artifact.path ? `(${artifact.path})` : "";
                return `${artifact.kind}${operation}${path}`;
            })
            .join(", ");
        lines.push(`[Artifacts] ${summary}`);
    }

    if (lines.length === 0) {
        return result.ok ? "Tool executed successfully." : "Tool execution failed.";
    }

    return lines.join("\n");
}

function countVerifiedEffects(result: ToolResult): { file: number; shell: number } {
    if (!result.ok) {
        return { file: 0, shell: 0 };
    }

    const hasFailingCheck = result.checks.some((check) => !check.ok);
    if (hasFailingCheck) {
        return { file: 0, shell: 0 };
    }

    let file = 0;
    let shell = 0;

    for (const artifact of result.artifacts) {
        const op = (artifact.operation || "").toLowerCase();
        if (artifact.kind === "file" && (op === "write" || op === "append" || op === "overwrite" || op === "create" || op === "update")) {
            file += 1;
        }
        if (artifact.kind === "shell" && (op === "execute" || op === "run")) {
            shell += 1;
        }
    }

    return { file, shell };
}

function normalizeToolResult(value: unknown, fallbackErrorPrefix: string): ToolResult {
    if (value && typeof value === "object") {
        const candidate = value as Partial<ToolResult>;
        if (typeof candidate.ok === "boolean" && Array.isArray(candidate.artifacts) && Array.isArray(candidate.checks)) {
            return {
                ok: candidate.ok,
                output: typeof candidate.output === "string" ? candidate.output : undefined,
                error: typeof candidate.error === "string" ? candidate.error : undefined,
                artifacts: candidate.artifacts,
                checks: candidate.checks,
            };
        }
    }

    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        const isErrorLike = normalized.startsWith("error") || normalized.startsWith("tool execution failed");
        return {
            ok: !isErrorLike,
            output: value,
            error: isErrorLike ? value : undefined,
            artifacts: [],
            checks: [],
        };
    }

    return {
        ok: false,
        error: `${fallbackErrorPrefix}${String(value)}`,
        output: `${fallbackErrorPrefix}${String(value)}`,
        artifacts: [],
        checks: [],
    };
}

function defaultModelForProvider(
    providerId: string,
    requirements?: { requireToolUse?: boolean },
): string {
    const provider = PROVIDERS.find((candidate) => candidate.id === providerId);
    const safeFallback = "llama-3.3-70b-versatile";
    if (!provider) return safeFallback;

    const requireToolUse = requirements?.requireToolUse === true;
    const modelMeetsRequirements = (modelId: string): boolean => (
        !isKnownDeprecatedModel(providerId, modelId)
        && isModelChatCapable({ id: modelId }, providerId)
        && (!requireToolUse || supportsToolUse(providerId, modelId))
    );

    if (provider.defaultModel && modelMeetsRequirements(provider.defaultModel)) {
        return provider.defaultModel;
    }
    const firstCompatible = provider.models.find((model) => modelMeetsRequirements(model.id));
    if (firstCompatible?.id) return firstCompatible.id;

    const firstNonDeprecated = provider.models.find((model) => !isKnownDeprecatedModel(providerId, model.id));
    return firstNonDeprecated?.id || safeFallback;
}

function isRenderableHistoryRole(role: Message["role"]): role is "user" | "assistant" {
    return role === "user" || role === "assistant";
}

interface ToolExecutionSummary {
    attempted: number;
    succeeded: number;
    failed: number;
    malformed: number;
    verifiedFileEffects: number;
    verifiedShellEffects: number;
}

function createEmptyToolExecutionSummary(): ToolExecutionSummary {
    return {
        attempted: 0,
        succeeded: 0,
        failed: 0,
        malformed: 0,
        verifiedFileEffects: 0,
        verifiedShellEffects: 0,
    };
}

function normalizeProviderToolCalls(toolCalls: LLMToolCall[] | undefined, turn: number): LLMToolCall[] {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];

    return toolCalls
        .map((call, index) => {
            const name = typeof call?.name === "string" ? call.name.trim() : "";
            if (!name) return null;
            const id = typeof call.id === "string" && call.id.trim().length > 0
                ? call.id.trim()
                : `tool_call_${turn + 1}_${index + 1}`;
            const argumentsText = typeof call.argumentsText === "string" ? call.argumentsText : "{}";
            return {
                id,
                name,
                argumentsText,
            } satisfies LLMToolCall;
        })
        .filter((call): call is LLMToolCall => Boolean(call));
}

export interface AgentConfig {
    id?: string;
    name: string;
    role: string;
    description?: string;
    style?: AgentStyle;
    systemPrompt: string;
    voiceId?: string;
    provider?: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    tools?: string[];
    accessMode?: AccessPermissionMode;
}

export class Agent {
    public id: string;
    public name: string;
    public role: string;
    public systemPrompt: string;
    public voiceId: string;
    public provider: string;
    public model: string;
    public reasoningEffort: ReasoningEffort;
    public tools: string[];
    public accessMode: AccessPermissionMode;

    constructor(config: AgentConfig) {
        this.id = config.id || uuidv4();
        this.name = config.name;
        this.role = config.role;
        this.systemPrompt = config.systemPrompt;
        this.voiceId = config.voiceId || "en-US-ChristopherNeural";
        this.provider = (config.provider || "groq").trim().toLowerCase();
        this.tools = config.tools || [];

        const requiresToolUse = this.tools.length > 0;
        const preferredModel = (config.model || "").trim();
        const fallbackModel = defaultModelForProvider(this.provider, { requireToolUse: requiresToolUse });
        const resolvedModel = preferredModel || fallbackModel;
        const candidateModel = isKnownDeprecatedModel(this.provider, resolvedModel)
            ? fallbackModel
            : resolvedModel;
        const candidateIsCompatible = isModelChatCapable({ id: candidateModel }, this.provider)
            && (!requiresToolUse || supportsToolUse(this.provider, candidateModel));
        this.model = candidateIsCompatible ? candidateModel : fallbackModel;

        const preferredReasoningEffort = config.reasoningEffort || DEFAULT_REASONING_EFFORT;
        this.reasoningEffort = supportsReasoningEffort(this.provider, this.model)
            ? preferredReasoningEffort
            : "none";
        this.accessMode = config.accessMode === "full_access" ? "full_access" : "ask_always";
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

    private getSystemMessage(enabledTools: Tool[], context?: ToolExecutionContext): string {
        const basePrompt = `You are ${this.name}, a ${this.role}.

Personality/Instructions:
${this.systemPrompt}

Start your response directly. Do not prefix with "System:" or "Agent:".`;

        if (enabledTools.length === 0) {
            return basePrompt;
        }

        const toolDescriptions = enabledTools
            .map((tool) => (
                `- ${tool.name} (ID: ${tool.id})\n  Description: ${tool.description}\n  InputSchema: ${JSON.stringify(tool.inputSchema)}`
            ))
            .join("\n\n");

        const sensitiveToolsEnabled = enabledTools.some((tool) => this.isPrivilegedTool(tool));
        const effectiveAccessMode = context?.toolAccessMode || this.accessMode;
        const turnAccessGranted = context?.toolAccessGranted === true;
        const accessGuidance = sensitiveToolsEnabled && effectiveAccessMode === "ask_always" && !turnAccessGranted
            ? "\n\nSensitive tool access is not approved for this turn. Do not call filesystem write or shell execution tools unless the user grants approval."
            : "";

        return `${basePrompt}

## AVAILABLE TOOLS
Use native tool/function calling only. Do not print tool call JSON in plain text.
Call at most one tool at a time unless your provider supports batched tool calls.
If the latest tool result fully satisfies the request, stop calling tools and answer the user.

Tools:
${toolDescriptions}${accessGuidance}`;
    }

    private isPrivilegedTool(tool: Tool): boolean {
        if (tool.privileged === true) return true;
        return PRIVILEGED_TOOL_IDS.has(tool.id) || PRIVILEGED_TOOL_IDS.has(tool.name);
    }

    private async executeTool(
        tool: Tool,
        args: Record<string, unknown>,
        context: ToolExecutionContext,
    ): Promise<ToolResult> {
        const effectiveAccessMode = context.toolAccessMode || this.accessMode;
        const turnAccessGranted = context.toolAccessGranted === true;
        if (this.isPrivilegedTool(tool) && effectiveAccessMode === "ask_always" && !turnAccessGranted) {
            const message = `Permission required for '${tool.name}'. This agent is in ask_always mode and this turn was not approved for write/shell operations.`;
            return {
                ok: false,
                error: message,
                output: message,
                artifacts: [],
                checks: [{
                    id: "permission_required",
                    ok: false,
                    description: "User approval is required before privileged tool execution.",
                }],
            };
        }

        const validation = validateToolArgs(tool.inputSchema!, args);
        if (!validation.ok) {
            const message = `Tool validation failed for '${tool.name}': ${validation.errors.join(" ")}`;
            return {
                ok: false,
                error: message,
                output: message,
                artifacts: [],
                checks: validation.errors.map((error, index) => ({
                    id: `validation_${index + 1}`,
                    ok: false,
                    description: error,
                })),
            };
        }

        try {
            const raw = await tool.execute(validation.normalizedArgs ?? args, context);
            return normalizeToolResult(raw, `Tool '${tool.name}' returned invalid result: `);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            const formatted = `Tool execution failed for '${tool.name}': ${message}`;
            return {
                ok: false,
                error: formatted,
                output: formatted,
                artifacts: [],
                checks: [{ id: "tool_execution_exception", ok: false, description: formatted }],
            };
        }
    }

    private toAssistantMessage(content: string, summary: ToolExecutionSummary | null): Message {
        return {
            id: uuidv4(),
            role: "assistant",
            name: this.name,
            content,
            ...(summary
                ? {
                    toolExecution: {
                        attempted: summary.attempted,
                        succeeded: summary.succeeded,
                        failed: summary.failed,
                        malformed: summary.malformed,
                        verifiedFileEffects: summary.verifiedFileEffects,
                        verifiedShellEffects: summary.verifiedShellEffects,
                    },
                }
                : {}),
            timestamp: Date.now(),
        };
    }

    async process(
        history: Message[],
        apiKeys: AgentApiKeys,
        availableTools: Tool[] = [],
        executionContext?: ToolExecutionContext,
    ): Promise<Message> {
        const llm = this.getLLMClient(apiKeys);
        const hasMcpAllAccess = this.tools.includes(MCP_ALL_TOOL_ID);
        const enabledTools = availableTools.filter(
            (tool) => this.tools.includes(tool.id)
                || this.tools.includes(tool.name)
                || (hasMcpAllAccess && tool.id.startsWith("mcp:")),
        );

        const canUseNativeToolCalling = llm.supportsNativeToolCalling === true;
        if (enabledTools.length > 0 && !canUseNativeToolCalling) {
            return this.toAssistantMessage(
                `Provider '${this.provider}' does not support native tool calling for this runtime.`,
                createEmptyToolExecutionSummary(),
            );
        }
        if (enabledTools.length > 0 && !supportsToolUse(this.provider, this.model)) {
            return this.toAssistantMessage(
                `Model '${this.model}' does not support native tool calling.`,
                createEmptyToolExecutionSummary(),
            );
        }

        const runId = executionContext?.runId || uuidv4();
        const toolSummary = createEmptyToolExecutionSummary();
        const repeatedCallCountBySignature = new Map<string, number>();
        let lastSuccessfulToolResult: string | null = null;

        const { providerTools, resolveToolId } = buildProviderToolManifest(enabledTools);

        const currentHistory: LLMMessage[] = [
            { role: "system", content: this.getSystemMessage(enabledTools, executionContext) },
            ...history
                .filter((message) => isRenderableHistoryRole(message.role))
                .map((message) => ({
                    role: message.role,
                    content: message.content,
                })),
        ];

        for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
            const response = await llm.chat(currentHistory, {
                temperature: enabledTools.length > 0 ? 0.2 : 0.7,
                max_tokens: 4096,
                reasoningEffort: this.reasoningEffort,
                tools: enabledTools.length > 0 ? providerTools : undefined,
                toolChoice: enabledTools.length > 0 ? "auto" : undefined,
            });

            const providerToolCalls = normalizeProviderToolCalls(response.toolCalls, turn);
            if (providerToolCalls.length === 0) {
                return this.toAssistantMessage(
                    response.content || "",
                    enabledTools.length > 0 ? toolSummary : null,
                );
            }

            currentHistory.push({
                role: "assistant",
                content: response.content || "",
                toolCalls: providerToolCalls,
            });

            for (const providerToolCall of providerToolCalls) {
                const toolId = resolveToolId(providerToolCall.name);
                const tool = toolId ? enabledTools.find((candidate) => candidate.id === toolId) : null;

                if (!tool) {
                    toolSummary.malformed += 1;
                    toolSummary.failed += 1;
                    currentHistory.push({
                        role: "tool",
                        name: providerToolCall.name,
                        toolCallId: providerToolCall.id,
                        content: `Error: Tool '${providerToolCall.name}' is not available for this agent.`,
                    });
                    continue;
                }

                const parsedArgsResult = parseToolArguments(providerToolCall.argumentsText);
                if (!parsedArgsResult.ok) {
                    toolSummary.malformed += 1;
                    toolSummary.failed += 1;
                    currentHistory.push({
                        role: "tool",
                        name: providerToolCall.name,
                        toolCallId: providerToolCall.id,
                        content: `Error: Malformed tool arguments for '${tool.name}': ${parsedArgsResult.error || "Invalid JSON object."}`,
                    });
                    continue;
                }

                const validation = validateToolArgs(tool.inputSchema!, parsedArgsResult.args);
                if (!validation.ok) {
                    toolSummary.malformed += 1;
                    toolSummary.failed += 1;
                    currentHistory.push({
                        role: "tool",
                        name: providerToolCall.name,
                        toolCallId: providerToolCall.id,
                        content: `Error: Tool validation failed for '${tool.name}': ${validation.errors.join(" ")}`,
                    });
                    continue;
                }

                const normalizedArgs = validation.normalizedArgs ?? parsedArgsResult.args;
                const signature = createToolCallSignature(tool.id, normalizedArgs);
                const repeatedCount = (repeatedCallCountBySignature.get(signature) ?? 0) + 1;
                repeatedCallCountBySignature.set(signature, repeatedCount);

                if (repeatedCount > MAX_IDENTICAL_TOOL_CALLS) {
                    toolSummary.failed += 1;
                    currentHistory.push({
                        role: "tool",
                        name: providerToolCall.name,
                        toolCallId: providerToolCall.id,
                        content: `Error: Duplicate tool call '${tool.name}' was attempted too many times with identical arguments.`,
                    });
                    continue;
                }

                const result = await this.executeTool(tool, normalizedArgs, {
                    ...executionContext,
                    runId,
                    agentId: this.id,
                    agentName: this.name,
                    providerId: this.provider,
                });

                toolSummary.attempted += 1;
                const serializedResult = formatToolResultForPrompt(result);

                if (!isToolResultError(result)) {
                    toolSummary.succeeded += 1;
                    lastSuccessfulToolResult = serializedResult;
                    const verifiedEffects = countVerifiedEffects(result);
                    toolSummary.verifiedFileEffects += verifiedEffects.file;
                    toolSummary.verifiedShellEffects += verifiedEffects.shell;
                } else {
                    toolSummary.failed += 1;
                }

                currentHistory.push({
                    role: "tool",
                    name: providerToolCall.name,
                    toolCallId: providerToolCall.id,
                    content: serializedResult,
                });
            }
        }

        const exhaustedMessage = lastSuccessfulToolResult
            ? `Tool-call loop limit reached before final narration. Last successful tool result:\n${lastSuccessfulToolResult}`
            : "Tool-call loop limit reached before producing a final answer.";

        return this.toAssistantMessage(
            exhaustedMessage,
            enabledTools.length > 0 ? toolSummary : null,
        );
    }
}
