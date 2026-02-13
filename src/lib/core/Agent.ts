import { v4 as uuidv4 } from "uuid";
import { providerRegistry } from "../llm/ProviderRegistry";
import type { LLMClient, ReasoningEffort } from "../llm/types";
import { DEFAULT_REASONING_EFFORT, PROVIDERS } from "../llm/constants";
import { isKnownDeprecatedModel, isModelChatCapable, supportsReasoningEffort } from "../llm/modelCatalog";
import { Message, Tool, ToolExecutionContext, ToolResult } from "./types";
import { buildProviderToolManifest } from "./tooling/providerToolAdapter";
import { looksLikeToolCallJson, parseToolCallsFromText } from "./tooling/toolCallParser";
import { createToolCallSignature, parseToolArguments } from "./tooling/toolArgParsing";
import { validateToolArgs } from "./tooling/toolValidation";

export type AgentStyle = "assistant" | "character" | "expert" | "custom";
export type AgentApiKeys = string | Record<string, string | null | undefined> | null;

const MAX_TOOL_TURNS = 12;
const TOOL_ARG_REPAIR_LIMIT = 2;

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
        const checkSummary = result.checks
            .map((check) => `${check.id}=${check.ok ? "ok" : "fail"}`)
            .join(", ");
        lines.push(`[Checks] ${checkSummary}`);
    }

    if (result.artifacts.length > 0) {
        const artifactSummary = result.artifacts
            .map((artifact) => {
                const operation = artifact.operation ? `:${artifact.operation}` : "";
                const path = artifact.path ? `(${artifact.path})` : "";
                return `${artifact.kind}${operation}${path}`;
            })
            .join(", ");
        lines.push(`[Artifacts] ${artifactSummary}`);
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

function defaultModelForProvider(providerId: string): string {
    const provider = PROVIDERS.find((candidate) => candidate.id === providerId);
    const safeFallback = "llama-3.3-70b-versatile";
    if (!provider) return safeFallback;
    if (provider.defaultModel && !isKnownDeprecatedModel(providerId, provider.defaultModel)) {
        return provider.defaultModel;
    }
    const firstNonDeprecated = provider.models.find((model) => !isKnownDeprecatedModel(providerId, model.id));
    return firstNonDeprecated?.id || safeFallback;
}

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
    reasoningEffort?: ReasoningEffort;
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
    public reasoningEffort: ReasoningEffort;
    public tools: string[];

    constructor(config: AgentConfig) {
        this.id = config.id || uuidv4();
        this.name = config.name;
        this.role = config.role;
        this.systemPrompt = config.systemPrompt;
        this.voiceId = config.voiceId || "en-US-ChristopherNeural";
        this.provider = (config.provider || "groq").trim().toLowerCase();
        const preferredModel = (config.model || "").trim();
        const fallbackModel = defaultModelForProvider(this.provider);
        const resolvedModel = preferredModel || fallbackModel;
        const candidateModel = isKnownDeprecatedModel(this.provider, resolvedModel)
            ? fallbackModel
            : resolvedModel;
        this.model = isModelChatCapable({ id: candidateModel }, this.provider) ? candidateModel : fallbackModel;
        const preferredReasoningEffort = config.reasoningEffort || DEFAULT_REASONING_EFFORT;
        this.reasoningEffort = supportsReasoningEffort(this.provider, this.model)
            ? preferredReasoningEffort
            : "none";
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

    private getSystemMessage(enabledTools: Tool[], canUseNativeToolCalling: boolean): string {
        const basePrompt = `You are ${this.name}, a ${this.role}.

Personality/Instructions:
${this.systemPrompt}

Start your response directly. Do not prefix with "System:" or "Agent:".`;

        if (enabledTools.length === 0) {
            return basePrompt;
        }

        const hasFileWriteTool = enabledTools.some((tool) => tool.id === "fs_write" || tool.name === "write_file");

        const toolDescriptions = enabledTools
            .map((tool) => (
                `- Tool: ${tool.name} (ID: ${tool.id})\n  Description: ${tool.description}\n  InputSchema: ${JSON.stringify(tool.inputSchema)}`
            ))
            .join("\n\n");

        const fileWriteInstructions = hasFileWriteTool
            ? `
File writing rules:
1. Do not send very large file bodies in one tool call.
2. For large files, split content into chunks (recommended <= 2000 chars per chunk).
3. First chunk: fs_write with mode="overwrite".
4. Remaining chunks: fs_write with mode="append".
5. After chunked writes, continue with the task instead of repeating the same chunk.`
            : "";

        const toolInvocationInstructions = canUseNativeToolCalling
            ? "Use native function-calling for tools. Do not emit tool calls as plain-text JSON unless function-calling is unavailable."
            : "Call tools by replying with only this JSON object:\n```json\n{ \"tool\": \"tool_id\", \"args\": { ... } }\n```";

        return `${basePrompt}

## AVAILABLE TOOLS
Use tools when they increase correctness.
${toolInvocationInstructions}
Call at most one tool at a time, then wait for the tool result.

Tools List:
${toolDescriptions}

${fileWriteInstructions}

If no tool is needed, answer normally.`;
    }

    private async executeTool(
        tool: Tool,
        args: Record<string, unknown>,
        executionContext?: ToolExecutionContext,
    ): Promise<ToolResult> {
        const validation = validateToolArgs(tool.inputSchema!, args);
        if (!validation.ok) {
            const message = `Tool validation failed for '${tool.name}': ${validation.errors.join(" ")}`;
            return {
                ok: false,
                error: message,
                output: message,
                artifacts: [],
                checks: validation.errors.map((err, index) => ({
                    id: `validation_${index + 1}`,
                    ok: false,
                    description: err,
                })),
            };
        }

        try {
            const raw = await tool.execute(args, {
                agentId: this.id,
                agentName: this.name,
                providerId: this.provider,
                squadId: executionContext?.squadId,
                squadName: executionContext?.squadName,
            });
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

    private getToolArgRepairKey(toolId: string, args: Record<string, unknown>): string {
        return createToolCallSignature(toolId, args);
    }

    private getToolArgValidationMessage(tool: Tool, errors: string[]): string {
        const schemaJson = JSON.stringify(tool.inputSchema ?? { type: "object", properties: {} });
        return `Tool argument validation failed for '${tool.name}'. ${errors.join(" ")} Return a corrected tool call using this schema: ${schemaJson}`;
    }

    private getToolArgParseErrorMessage(tool: Tool, parseError: string): string {
        const schemaJson = JSON.stringify(tool.inputSchema ?? { type: "object", properties: {} });
        return `Tool arguments for '${tool.name}' were malformed: ${parseError} Return a corrected tool call with arguments as a valid JSON object matching: ${schemaJson}`;
    }

    async process(
        history: Message[],
        apiKeys: AgentApiKeys,
        availableTools: Tool[] = [],
        executionContext?: ToolExecutionContext,
    ): Promise<Message> {
        const llm = this.getLLMClient(apiKeys);
        const enabledTools = availableTools.filter(
            (tool) => this.tools.includes(tool.id) || this.tools.includes(tool.name),
        );

        const { providerTools, resolveToolId } = buildProviderToolManifest(enabledTools);
        const canUseNativeToolCalling = llm.supportsNativeToolCalling === true;
        const successfulToolCallSignatures = new Set<string>();
        const toolResultBySignature = new Map<string, string>();
        const toolArgRepairAttemptsByKey = new Map<string, number>();
        let lastSuccessfulToolResult: string | null = null;
        let toolAttemptCount = 0;
        let toolSuccessCount = 0;
        let toolFailureCount = 0;
        let malformedToolCallCount = 0;
        let verifiedFileEffectCount = 0;
        let verifiedShellEffectCount = 0;

        const currentHistory = [
            { role: "system" as const, content: this.getSystemMessage(enabledTools, canUseNativeToolCalling) },
            ...history
                .filter((m) => m.role === "user" || m.role === "assistant")
                .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        ];

        for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
            const response = await llm.chat(currentHistory, {
                temperature: enabledTools.length > 0 ? 0.2 : 0.7,
                max_tokens: 4096,
                reasoningEffort: this.reasoningEffort,
                tools: canUseNativeToolCalling ? providerTools : undefined,
                toolChoice: canUseNativeToolCalling && providerTools.length > 0 ? "auto" : undefined,
            });

            const assistantContent = response.content || "";
            const providerToolCalls = response.toolCalls || [];

            if (providerToolCalls.length > 0) {
                const summarizedToolNames = providerToolCalls.map((call) => call.name).join(", ");
                currentHistory.push({ role: "assistant", content: assistantContent || `[Tool Call] ${summarizedToolNames}` });

                for (const providerToolCall of providerToolCalls) {
                    const toolId = resolveToolId(providerToolCall.name);
                    const tool = toolId ? enabledTools.find((candidate) => candidate.id === toolId) : null;

                    if (!tool) {
                        currentHistory.push({ role: "user", content: `Error: Tool '${providerToolCall.name}' not found.` });
                        continue;
                    }

                    const parsedArgsResult = parseToolArguments(providerToolCall.argumentsText);
                    if (!parsedArgsResult.ok) {
                        malformedToolCallCount += 1;
                        const repairKey = `${tool.id}:parse:${providerToolCall.argumentsText || ""}`;
                        const attempt = (toolArgRepairAttemptsByKey.get(repairKey) ?? 0) + 1;
                        toolArgRepairAttemptsByKey.set(repairKey, attempt);
                        if (attempt <= TOOL_ARG_REPAIR_LIMIT) {
                            currentHistory.push({
                                role: "user",
                                content: this.getToolArgParseErrorMessage(tool, parsedArgsResult.error || "Invalid JSON payload."),
                            });
                        } else {
                            currentHistory.push({
                                role: "user",
                                content: `Repeated malformed arguments for '${tool.name}'. Either fix arguments or continue without this call.`,
                            });
                        }
                        continue;
                    }

                    const validation = validateToolArgs(tool.inputSchema!, parsedArgsResult.args);
                    if (!validation.ok) {
                        malformedToolCallCount += 1;
                        const repairKey = this.getToolArgRepairKey(tool.id, parsedArgsResult.args);
                        const attempt = (toolArgRepairAttemptsByKey.get(repairKey) ?? 0) + 1;
                        toolArgRepairAttemptsByKey.set(repairKey, attempt);
                        if (attempt <= TOOL_ARG_REPAIR_LIMIT) {
                            currentHistory.push({
                                role: "user",
                                content: this.getToolArgValidationMessage(tool, validation.errors),
                            });
                        } else {
                            currentHistory.push({
                                role: "user",
                                content: `Repeated invalid arguments for '${tool.name}'. Either fix arguments or continue without this call.`,
                            });
                        }
                        continue;
                    }
                    const parsedArgs = validation.normalizedArgs ?? parsedArgsResult.args;

                    const callSignature = createToolCallSignature(tool.id, parsedArgs);
                    if (successfulToolCallSignatures.has(callSignature)) {
                        const priorResult = toolResultBySignature.get(callSignature) || "This exact tool call already succeeded.";
                        currentHistory.push({
                            role: "user",
                            content: `[Tool Result for ${tool.name}]:\n${priorResult}\n\nThis exact tool call already succeeded. Do not repeat it. Provide your final answer unless a different tool is required.`,
                        });
                        continue;
                    }

                    const result = await this.executeTool(tool, parsedArgs, executionContext);
                    toolAttemptCount += 1;
                    const serializedResult = formatToolResultForPrompt(result);
                    toolResultBySignature.set(callSignature, serializedResult);

                    if (!isToolResultError(result)) {
                        successfulToolCallSignatures.add(callSignature);
                        lastSuccessfulToolResult = serializedResult;
                        toolSuccessCount += 1;
                        const verifiedEffects = countVerifiedEffects(result);
                        verifiedFileEffectCount += verifiedEffects.file;
                        verifiedShellEffectCount += verifiedEffects.shell;
                    } else {
                        toolFailureCount += 1;
                    }

                    currentHistory.push({
                        role: "user",
                        content: `[Tool Result for ${tool.name}]:\n${serializedResult}\n\nIf this satisfies the task, stop calling tools and provide your final answer.`,
                    });
                }
                continue;
            }

            if (enabledTools.length > 0) {
                const parsedToolCalls = parseToolCallsFromText(assistantContent);
                if (parsedToolCalls.length > 0) {
                    currentHistory.push({ role: "assistant", content: assistantContent });

                    for (const parsedToolCall of parsedToolCalls) {
                        const tool = enabledTools.find(
                            (candidate) => candidate.id === parsedToolCall.tool || candidate.name === parsedToolCall.tool,
                        );

                        if (!tool) {
                            currentHistory.push({ role: "user", content: `Error: Tool '${parsedToolCall.tool}' not found.` });
                            continue;
                        }

                        const validation = validateToolArgs(tool.inputSchema!, parsedToolCall.args);
                        if (!validation.ok) {
                            malformedToolCallCount += 1;
                            const repairKey = this.getToolArgRepairKey(tool.id, parsedToolCall.args);
                            const attempt = (toolArgRepairAttemptsByKey.get(repairKey) ?? 0) + 1;
                            toolArgRepairAttemptsByKey.set(repairKey, attempt);
                            if (attempt <= TOOL_ARG_REPAIR_LIMIT) {
                                currentHistory.push({
                                    role: "user",
                                    content: this.getToolArgValidationMessage(tool, validation.errors),
                                });
                            } else {
                                currentHistory.push({
                                    role: "user",
                                    content: `Repeated invalid arguments for '${tool.name}'. Either fix arguments or continue without this call.`,
                                });
                            }
                            continue;
                        }

                        const normalizedArgs = validation.normalizedArgs ?? parsedToolCall.args;
                        const callSignature = createToolCallSignature(tool.id, normalizedArgs);
                        if (successfulToolCallSignatures.has(callSignature)) {
                            const priorResult = toolResultBySignature.get(callSignature) || "This exact tool call already succeeded.";
                            currentHistory.push({
                                role: "user",
                                content: `[Tool Result for ${tool.name}]:\n${priorResult}\n\nThis exact tool call already succeeded. Do not repeat it. Provide your final answer unless a different tool is required.`,
                            });
                            continue;
                        }

                        const result = await this.executeTool(tool, normalizedArgs, executionContext);
                        toolAttemptCount += 1;
                        const serializedResult = formatToolResultForPrompt(result);
                        toolResultBySignature.set(callSignature, serializedResult);

                        if (!isToolResultError(result)) {
                            successfulToolCallSignatures.add(callSignature);
                            lastSuccessfulToolResult = serializedResult;
                            toolSuccessCount += 1;
                            const verifiedEffects = countVerifiedEffects(result);
                            verifiedFileEffectCount += verifiedEffects.file;
                            verifiedShellEffectCount += verifiedEffects.shell;
                        } else {
                            toolFailureCount += 1;
                        }

                        currentHistory.push({
                            role: "user",
                            content: `[Tool Result for ${tool.name}]:\n${serializedResult}\n\nIf this satisfies the task, stop calling tools and provide your final answer.`,
                        });
                    }
                    continue;
                }

                if (looksLikeToolCallJson(assistantContent)) {
                    malformedToolCallCount += 1;
                    currentHistory.push({ role: "assistant", content: assistantContent });
                    currentHistory.push({
                        role: "user",
                        content: "Error: Invalid tool-call JSON format. Return ONLY valid JSON as { \"tool\": \"tool_id\", \"args\": { ... } } with properly escaped string values.",
                    });
                    continue;
                }
            }

            return {
                id: uuidv4(),
                role: "assistant",
                name: this.name,
                content: assistantContent,
                ...(enabledTools.length > 0
                    ? {
                        toolExecution: {
                            attempted: toolAttemptCount,
                            succeeded: toolSuccessCount,
                            failed: toolFailureCount,
                            malformed: malformedToolCallCount,
                            verifiedFileEffects: verifiedFileEffectCount,
                            verifiedShellEffects: verifiedShellEffectCount,
                        },
                    }
                    : {}),
                timestamp: Date.now(),
            };
        }

        if (lastSuccessfulToolResult) {
            return {
                id: uuidv4(),
                role: "assistant",
                name: this.name,
                content: `Reached the tool-call limit before producing final narration. Last successful tool result:\n${lastSuccessfulToolResult}`,
                ...(enabledTools.length > 0
                    ? {
                        toolExecution: {
                            attempted: toolAttemptCount,
                            succeeded: toolSuccessCount,
                            failed: toolFailureCount,
                            malformed: malformedToolCallCount,
                            verifiedFileEffects: verifiedFileEffectCount,
                            verifiedShellEffects: verifiedShellEffectCount,
                        },
                    }
                    : {}),
                timestamp: Date.now(),
            };
        }

        return {
            id: uuidv4(),
            role: "assistant",
            name: this.name,
            content: "Error: Task limit exceeded (too many tool calls).",
            ...(enabledTools.length > 0
                ? {
                    toolExecution: {
                        attempted: toolAttemptCount,
                        succeeded: toolSuccessCount,
                        failed: toolFailureCount,
                        malformed: malformedToolCallCount,
                        verifiedFileEffects: verifiedFileEffectCount,
                        verifiedShellEffects: verifiedShellEffectCount,
                    },
                }
                : {}),
            timestamp: Date.now(),
        };
    }
}
