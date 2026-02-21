import { v4 as uuidv4 } from "uuid";
import { providerRegistry } from "../llm/ProviderRegistry";
import type { LLMClient, LLMMessage, LLMToolCall, ReasoningEffort } from "../llm/types";
import { DEFAULT_REASONING_EFFORT, PROVIDERS } from "../llm/constants";
import { isKnownDeprecatedModel, isModelChatCapable, supportsReasoningEffort, supportsToolUse } from "../llm/modelCatalog";
import { Message, Tool, ToolExecutionContext, ToolResult } from "./types";
import { buildProviderToolManifest } from "./tooling/providerToolAdapter";
import { createToolCallSignature, parseToolArguments } from "./tooling/toolArgParsing";
import { validateToolArgs } from "./tooling/toolValidation";
import { normalizeToolIds } from "./tooling/toolIds";
import type { AgentEvolutionConfig } from "@/lib/evolution/types";
import { replaceSecretPlaceholdersInArgs } from "@/lib/runtime/services/secretsService";
import {
    buildManagedHistory,
    estimateTokenCount,
    inferContextWindowTokens,
    injectOrphanToolResultErrors,
    pruneExpiredToolResults,
} from "./contextManagement";
import { resolveContextWindowTokensFromCatalog } from "@/lib/llm/runtimeModelMetadata";
import type { RuntimePromptBeforeEvent } from "@/lib/runtime/hooks/types";

export type AgentStyle = "assistant" | "character" | "expert" | "custom";
export type AccessPermissionMode = "ask_always" | "full_access";
export type AgentApiKeys = string | Record<string, string | null | undefined> | null;

const MAX_TOOL_TURNS = 24;
const MAX_IDENTICAL_TOOL_CALLS = 2;
const PRIVILEGED_TOOL_IDS = new Set(["shell_execute", "execute_command"]);
const MCP_ALL_TOOL_ID = "mcp_all";
const MIN_CONTEXT_WINDOW_TOKENS = 16_000;
const WARN_CONTEXT_WINDOW_TOKENS = 32_000;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 65_536;
const RESERVED_RESPONSE_TOKENS = 5_120;
const RESERVED_TOOLING_TOKENS = 1_200;
const TOOL_MODE_PROMPT_TOKEN_CAP = 5_000;
const TOOL_MODE_MAX_RESPONSE_TOKENS = 1_536;
const SUBAGENTS_TOOL_ID = "subagents";

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

function isSubAgentsTool(tool: Tool): boolean {
    const normalizedId = (tool.id || "").trim().toLowerCase();
    const normalizedName = (tool.name || "").trim().toLowerCase();
    return normalizedId === SUBAGENTS_TOOL_ID || normalizedName === SUBAGENTS_TOOL_ID;
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
    evolution?: AgentEvolutionConfig;
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
        this.tools = normalizeToolIds(config.tools);

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
            .map((tool) => {
                const argKeys = tool.inputSchema?.properties
                    ? Object.keys(tool.inputSchema.properties)
                    : [];
                const argHint = argKeys.length > 0
                    ? `\n  Args: ${argKeys.join(", ")}`
                    : "";
                return `- ${tool.name} (ID: ${tool.id})\n  Description: ${tool.description}${argHint}`;
            })
            .join("\n\n");

        const sensitiveToolsEnabled = enabledTools.some((tool) => this.isPrivilegedTool(tool));
        const effectiveAccessMode = context?.toolAccessMode || this.accessMode;
        const turnAccessGranted = context?.toolAccessGranted === true;
        const accessGuidance = sensitiveToolsEnabled && effectiveAccessMode === "ask_always" && !turnAccessGranted
            ? "\n\nSensitive tool access is not approved for this turn. Do not call filesystem write or shell execution tools unless the user grants approval."
            : "";
        const workspaceRoot = (context?.agentWorkspaceRootRelative || "").trim();
        const workspaceArtifactsDir = (context?.agentWorkspaceArtifactsDirRelative || "").trim();
        const workspaceGuidance = workspaceRoot
            ? `\n\nWorkspace policy: Your writable root is "${workspaceRoot}". Keep filesystem and shell operations inside this root.`
                + (workspaceArtifactsDir
                    ? ` Prefer placing generated artifacts under "${workspaceArtifactsDir}".`
                    : "")
                + " Bootstrap each task by checking existing files in this workspace before creating new ones."
            : "";
        const delegationGuidance = enabledTools.some((tool) => isSubAgentsTool(tool))
            ? "\n\nDelegation policy: For multi-step or tool-heavy work, spawn focused sub-agents via `subagents`. Pass only task-relevant facts, not the full chat transcript."
            : "";

        return `${basePrompt}

## AVAILABLE TOOLS
Use native tool/function calling only. Do not print tool call JSON in plain text.
Call at most one tool at a time unless your provider supports batched tool calls.
If the latest tool result fully satisfies the request, stop calling tools and answer the user.

Tools:
${toolDescriptions}${accessGuidance}${workspaceGuidance}${delegationGuidance}`;
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
        const runId = executionContext?.runId || uuidv4();
        const runStartedAt = Date.now();
        const runtimeHookRegistry = executionContext?.runtimeHookRegistry;
        const toolSummary = createEmptyToolExecutionSummary();

        const finalizeResponse = async (message: Message): Promise<Message> => {
            if (runtimeHookRegistry) {
                await runtimeHookRegistry.emit("response_stream", {
                    runId,
                    agentId: this.id,
                    timestamp: Date.now(),
                    chunk: message.content || "",
                    chunkIndex: 0,
                    metadata: { synthetic: true },
                });
                await runtimeHookRegistry.emit("run_end", {
                    runId,
                    agentId: this.id,
                    timestamp: Date.now(),
                    status: "completed",
                    durationMs: Math.max(0, Date.now() - runStartedAt),
                    output: message.content,
                });
            }
            return message;
        };

        const canUseNativeToolCalling = llm.supportsNativeToolCalling === true;
        if (enabledTools.length > 0 && !canUseNativeToolCalling) {
            return finalizeResponse(this.toAssistantMessage(
                `Provider '${this.provider}' does not support native tool calling for this runtime.`,
                createEmptyToolExecutionSummary(),
            ));
        }
        if (enabledTools.length > 0 && !supportsToolUse(this.provider, this.model)) {
            return finalizeResponse(this.toAssistantMessage(
                `Model '${this.model}' does not support native tool calling.`,
                createEmptyToolExecutionSummary(),
            ));
        }

        const repeatedCallCountBySignature = new Map<string, number>();
        let lastSuccessfulToolResult: string | null = null;

        const { providerTools, resolveToolId } = buildProviderToolManifest(enabledTools);
        const catalogContextWindow = await resolveContextWindowTokensFromCatalog(this.provider, this.model);
        const inferredContextWindow = inferContextWindowTokens(this.model);
        const resolvedContextWindow = catalogContextWindow || inferredContextWindow;
        if (typeof resolvedContextWindow === "number" && resolvedContextWindow < MIN_CONTEXT_WINDOW_TOKENS) {
            return finalizeResponse(this.toAssistantMessage(
                `Model '${this.model}' appears to have a context window of ${resolvedContextWindow} tokens. This runtime blocks runs below ${MIN_CONTEXT_WINDOW_TOKENS} tokens to avoid context loss.`,
                enabledTools.length > 0 ? toolSummary : null,
            ));
        }

        const contextWarnings: string[] = [];
        if (typeof resolvedContextWindow === "number" && resolvedContextWindow < WARN_CONTEXT_WINDOW_TOKENS) {
            contextWarnings.push(
                `This model appears to have a constrained context window (${resolvedContextWindow} tokens). Be concise and avoid unnecessary repetition.`,
            );
        }
        if (!catalogContextWindow && inferredContextWindow) {
            contextWarnings.push("Context window estimated from model id because catalog metadata was unavailable.");
        }

        const toolModeEnabled = enabledTools.length > 0;
        const effectiveContextWindow = resolvedContextWindow || DEFAULT_CONTEXT_WINDOW_TOKENS;
        const maxPromptTokensFromModel = Math.max(2_048, effectiveContextWindow - RESERVED_RESPONSE_TOKENS);
        const maxPromptTokens = toolModeEnabled
            ? Math.min(maxPromptTokensFromModel, TOOL_MODE_PROMPT_TOKEN_CAP)
            : maxPromptTokensFromModel;
        const maxResponseTokens = toolModeEnabled ? TOOL_MODE_MAX_RESPONSE_TOKENS : 4096;
        if (toolModeEnabled && maxPromptTokens < maxPromptTokensFromModel) {
            contextWarnings.push(
                `Tool-call context narrowing is active: prompt budget capped to ~${maxPromptTokens} tokens to keep delegation/tool runs stable in long chats.`,
            );
        }
        const baseSystemMessage = this.getSystemMessage(enabledTools, executionContext);
        const renderableHistory: LLMMessage[] = history
            .filter((message) => isRenderableHistoryRole(message.role))
            .map((message) => ({
                role: message.role,
                content: message.content,
            }));
        const systemTokenCost = estimateTokenCount(baseSystemMessage) + RESERVED_TOOLING_TOKENS;
        const historyTokenBudget = Math.max(512, maxPromptTokens - systemTokenCost);
        const managedHistory = buildManagedHistory(renderableHistory, historyTokenBudget);
        if (managedHistory.trimmedMessageCount > 0) {
            contextWarnings.push(`Long message guard trimmed ${managedHistory.trimmedMessageCount} oversized message(s) using head/tail preservation.`);
        }
        if (managedHistory.droppedTurnCount > 0) {
            contextWarnings.push(`Turn-boundary compaction dropped ${managedHistory.droppedTurnCount} older turn(s) and injected a staged summary.`);
        }

        let effectiveBaseSystemMessage = baseSystemMessage;
        if (runtimeHookRegistry) {
            const latestUserPrompt = [...history]
                .slice()
                .reverse()
                .find((message) => message.role === "user")?.content || "";
            const contextMessages: RuntimePromptBeforeEvent["contextMessages"] = managedHistory.messages.map((message) => ({
                role: message.role === "system" || message.role === "user" || message.role === "assistant" || message.role === "tool"
                    ? message.role
                    : "assistant",
                content: message.content,
            }));
            const promptBeforeEvent: RuntimePromptBeforeEvent = {
                runId,
                agentId: this.id,
                timestamp: Date.now(),
                systemPrompt: baseSystemMessage,
                userPrompt: latestUserPrompt,
                contextMessages,
                systemPromptAppendices: [],
            };
            await runtimeHookRegistry.emit("prompt_before", promptBeforeEvent);
            const appendices = Array.isArray(promptBeforeEvent.systemPromptAppendices)
                ? promptBeforeEvent.systemPromptAppendices.filter((entry) => typeof entry === "string" && entry.trim().length > 0)
                : [];
            effectiveBaseSystemMessage = appendices.length > 0
                ? `${promptBeforeEvent.systemPrompt}\n\n${appendices.join("\n\n")}`
                : promptBeforeEvent.systemPrompt;
        }

        let systemMessage = contextWarnings.length > 0
            ? `${effectiveBaseSystemMessage}\n\n## CONTEXT MANAGEMENT\n${contextWarnings.map((line) => `- ${line}`).join("\n")}`
            : effectiveBaseSystemMessage;

        if (runtimeHookRegistry) {
            const promptAfterEvent = {
                runId,
                agentId: this.id,
                timestamp: Date.now(),
                prompt: systemMessage,
            };
            await runtimeHookRegistry.emit("prompt_after", promptAfterEvent);
            systemMessage = promptAfterEvent.prompt;
        }

        let currentHistory: LLMMessage[] = [
            { role: "system", content: systemMessage },
            ...managedHistory.messages,
        ];
        const toolResultInsertedAtByCallId = new Map<string, number>();
        let prunedToolResultCount = 0;

        for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
            if (toolModeEnabled && currentHistory.length > 1) {
                const compacted = buildManagedHistory(currentHistory.slice(1), historyTokenBudget);
                currentHistory = [{ ...currentHistory[0] }, ...compacted.messages];
            }

            const repaired = injectOrphanToolResultErrors(currentHistory);
            if (repaired.injectedCount > 0) {
                currentHistory = repaired.messages;
                toolSummary.failed += repaired.injectedCount;
            }

            const pruned = pruneExpiredToolResults(currentHistory, {
                providerId: this.provider,
                now: Date.now(),
                maxPromptTokens,
                toolResultInsertedAtByCallId,
            });
            if (pruned.prunedCount > 0) {
                prunedToolResultCount += pruned.prunedCount;
                currentHistory = pruned.messages;
            }

            const response = await llm.chat(currentHistory, {
                temperature: enabledTools.length > 0 ? 0.2 : 0.7,
                max_tokens: maxResponseTokens,
                reasoningEffort: this.reasoningEffort,
                tools: enabledTools.length > 0 ? providerTools : undefined,
                toolChoice: enabledTools.length > 0 ? "auto" : undefined,
            });

            const providerToolCalls = normalizeProviderToolCalls(response.toolCalls, turn);
            if (providerToolCalls.length === 0) {
                return finalizeResponse(this.toAssistantMessage(
                    response.content || "",
                    enabledTools.length > 0 ? toolSummary : null,
                ));
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

                const argsWithSecrets = replaceSecretPlaceholdersInArgs(
                    parsedArgsResult.args,
                    executionContext?.secretValues,
                );
                const validation = validateToolArgs(tool.inputSchema!, argsWithSecrets);
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

                const normalizedArgs = validation.normalizedArgs ?? argsWithSecrets;
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

                if (runtimeHookRegistry) {
                    await runtimeHookRegistry.emit("tool_before", {
                        runId,
                        agentId: this.id,
                        timestamp: Date.now(),
                        toolId: tool.id,
                        toolName: tool.name,
                        args: normalizedArgs,
                    });
                }
                const toolStartedAt = Date.now();
                const result = await this.executeTool(tool, normalizedArgs, {
                    ...executionContext,
                    runId,
                    agentId: this.id,
                    agentName: this.name,
                    providerId: this.provider,
                });
                if (runtimeHookRegistry) {
                    await runtimeHookRegistry.emit("tool_after", {
                        runId,
                        agentId: this.id,
                        timestamp: Date.now(),
                        toolId: tool.id,
                        toolName: tool.name,
                        args: normalizedArgs,
                        result,
                        durationMs: Math.max(0, Date.now() - toolStartedAt),
                    });
                }

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
                if (providerToolCall.id.trim().length > 0) {
                    toolResultInsertedAtByCallId.set(providerToolCall.id.trim(), Date.now());
                }
            }
        }

        try {
            const recoveryInstruction = lastSuccessfulToolResult
                ? [
                    "Tool-call budget is exhausted.",
                    "Do not call any tools.",
                    "Provide the final user-facing answer now using the conversation and latest tool results.",
                    "If relevant, incorporate this latest successful tool result:",
                    lastSuccessfulToolResult,
                ].join("\n\n")
                : [
                    "Tool-call budget is exhausted.",
                    "Do not call any tools.",
                    "Provide the best possible final user-facing answer from available context.",
                ].join("\n\n");

            const recoveryResponse = await llm.chat(
                [
                    ...currentHistory,
                    {
                        role: "user",
                        content: recoveryInstruction,
                    },
                ],
                {
                    temperature: 0.2,
                    max_tokens: maxResponseTokens,
                    reasoningEffort: this.reasoningEffort,
                },
            );

            const recoveryText = (recoveryResponse.content || "").trim();
            if (recoveryText.length > 0) {
                return finalizeResponse(this.toAssistantMessage(
                    recoveryText,
                    enabledTools.length > 0 ? toolSummary : null,
                ));
            }
        } catch {
            // Ignore recovery errors and return a safe fallback below.
        }

        const latestResult = lastSuccessfulToolResult
            ? lastSuccessfulToolResult.slice(0, 6000)
            : "";
        const fallbackMessage = latestResult
            ? `I hit a tool-call limit before finishing, but here is the latest successful result:\n\n${latestResult}`
            : "I hit a tool-call limit before finishing the response. Please retry and I will continue.";
        const withPruneNote = prunedToolResultCount > 0
            ? `${fallbackMessage}\n\n[Some older tool results were pruned after provider cache expiry.]`
            : fallbackMessage;

        return finalizeResponse(this.toAssistantMessage(
            withPruneNote,
            enabledTools.length > 0 ? toolSummary : null,
        ));
    }
}
