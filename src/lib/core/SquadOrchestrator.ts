import { v4 as uuidv4 } from "uuid";
import { PROVIDERS } from "../llm/constants";
import type {
    LLMChatOptions,
    LLMClient,
    LLMMessage,
    LLMResponse,
    LLMResponseFormat,
} from "../llm/types";
import { AccessPermissionMode, Agent, AgentApiKeys, AgentConfig } from "./Agent";
import { Message, Tool } from "./types";
import { SubAgentRuntime } from "./runtime/SubAgentRuntime";
import { ensureAgentWorkspace } from "./agentWorkspace";
import {
    DEFAULT_SQUAD_ORCHESTRATOR_PROFILE,
    DirectorDecision,
    SquadConfig,
    SquadOrchestratorProfile,
    SquadRunResult,
    SquadRunStep,
    SquadRuntime,
    getSquadContext,
    getSquadGoal,
    getSquadInteractionConfig,
    normalizeSquadConfig,
} from "./Squad";

const DEFAULT_MAX_ITERATIONS = 10;
const DIRECTOR_HISTORY_LIMIT = 16;
const GREETING_ONLY_PATTERN = /^(hi|hello|hey|yo|sup|howdy|good morning|good afternoon|good evening|thanks|thank you|ok|okay|k|cool|nice|lol|hmm|huh|yes|no|maybe|help)$/;
const SMALL_TALK_ONLY_PATTERN = /^(how are you|whats up|what's up|who are you)$/;
const GROQ_STRICT_ORCHESTRATOR_DEFAULT_MODEL = "gpt-oss-20b";
const DIRECTOR_DECISION_RESPONSE_SCHEMA: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    properties: {
        status: {
            type: "string",
            enum: ["continue", "complete", "needs_user_input", "blocked"],
        },
        summary: {
            type: "string",
            minLength: 1,
        },
        targetAgentId: {
            type: "string",
            minLength: 1,
        },
        instruction: {
            type: "string",
            minLength: 1,
        },
        responseToUser: {
            type: "string",
            minLength: 1,
        },
        userQuestion: {
            type: "string",
            minLength: 1,
        },
        blockerReason: {
            type: "string",
            minLength: 1,
        },
    },
    required: ["status", "summary"],
};

function extractJsonObject(raw: string): Record<string, unknown> | null {
    const stripped = raw.replace(/```json/gi, "").replace(/```/g, "").trim();

    try {
        return JSON.parse(stripped) as Record<string, unknown>;
    } catch {
        // Ignore and try to find the first balanced JSON object.
    }

    const start = stripped.indexOf("{");
    if (start < 0) return null;

    let depth = 0;
    for (let i = start; i < stripped.length; i++) {
        const ch = stripped[i];
        if (ch === "{") depth += 1;
        if (ch === "}") depth -= 1;

        if (depth === 0) {
            const candidate = stripped.slice(start, i + 1);
            try {
                return JSON.parse(candidate) as Record<string, unknown>;
            } catch {
                return null;
            }
        }
    }

    return null;
}

function toStringArray(values: string[]): string {
    return values.length > 0 ? values.join("\n") : "None yet.";
}

interface McpCapabilitySnapshot {
    hasFileIo: boolean;
    hasFileWrite: boolean;
    hasShell: boolean;
    hasWebResearch: boolean;
}

function buildMcpCapabilitySnapshot(availableTools: Tool[]): McpCapabilitySnapshot {
    let hasFileIo = false;
    let hasFileWrite = false;
    let hasShell = false;
    let hasWebResearch = false;

    for (const tool of availableTools) {
        const normalizedId = (tool.id || "").trim().toLowerCase();
        if (!normalizedId.startsWith("mcp:")) continue;

        const match = /^mcp:([^:]+):(.+)$/.exec(normalizedId);
        const serviceId = match?.[1] || "";
        const toolName = match?.[2] || normalizedId;

        const filesystemService = serviceId.includes("filesystem");
        const shellService = /(shell|terminal|command)/.test(serviceId);
        const webService = /(web|search|browser|fetch|serp)/.test(serviceId);

        if (filesystemService) {
            hasFileIo = true;
            if (/(write|edit|append|create_file|move_file|rename|update)/.test(toolName)) {
                hasFileWrite = true;
            }
        }

        if (shellService && /(run|exec|execute|command|shell|spawn)/.test(toolName)) {
            hasShell = true;
        }

        if (webService || /(web|search|browse|fetch|internet|source)/.test(toolName)) {
            hasWebResearch = true;
        }
    }

    if (hasFileWrite) hasFileIo = true;

    return {
        hasFileIo,
        hasFileWrite,
        hasShell,
        hasWebResearch,
    };
}

function inferToolCapabilities(toolIds: string[], mcpCapabilities: McpCapabilitySnapshot): string[] {
    const capabilities = new Set<string>();
    const hasMcpAll = toolIds.includes("mcp_all");

    for (const toolId of toolIds) {
        if (toolId === "fs_read" || toolId === "fs_write" || toolId === "fs_list") {
            capabilities.add("file-io");
        }
        if (toolId === "shell_execute") {
            capabilities.add("shell");
        }
        if (toolId === "web_search") {
            capabilities.add("web-research");
        }
        if (toolId === "mcp_all") {
            capabilities.add("mcp-services");
        }
        if (toolId === "subagents") {
            capabilities.add("delegation");
        }
    }

    if (hasMcpAll && mcpCapabilities.hasFileIo) capabilities.add("file-io");
    if (hasMcpAll && mcpCapabilities.hasShell) capabilities.add("shell");
    if (hasMcpAll && mcpCapabilities.hasWebResearch) capabilities.add("web-research");

    return Array.from(capabilities);
}

interface WorkerExecutionExpectation {
    requiresToolExecution: boolean;
    requiresFileEffects: boolean;
    requiresShellEffects: boolean;
}

interface WorkerExecutionVerification {
    ok: boolean;
    reason: string;
}

interface SquadRunOptions {
    toolAccessGranted?: boolean;
}

type OrchestratorDebugLogFn = (message: string, data?: unknown) => void;

function inferWorkerExecutionExpectation(
    instruction: string,
    worker: AgentConfig,
    mcpCapabilities: McpCapabilitySnapshot,
): WorkerExecutionExpectation {
    const toolIds = worker.tools || [];
    if (toolIds.length === 0) {
        return {
            requiresToolExecution: false,
            requiresFileEffects: false,
            requiresShellEffects: false,
        };
    }

    const normalized = instruction.toLowerCase();
    const hasMcpAll = toolIds.includes("mcp_all");
    const hasFileTool = toolIds.includes("fs_read") || toolIds.includes("fs_write") || toolIds.includes("fs_list")
        || toolIds.includes("read_file") || toolIds.includes("write_file") || toolIds.includes("list_directory")
        || (hasMcpAll && mcpCapabilities.hasFileIo);
    const hasShellTool = toolIds.includes("shell_execute") || toolIds.includes("execute_command")
        || (hasMcpAll && mcpCapabilities.hasShell);
    const hasWebTool = toolIds.includes("web_search") || toolIds.includes("search_internet")
        || (hasMcpAll && mcpCapabilities.hasWebResearch);

    const hasExplicitFileReference = /(?:^|\s)(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,10}(?=\s|$)/.test(normalized);
    const codingIntent = /(implement|build|create|develop|code|program|refactor|fix|add|update|modify)/.test(normalized);
    const codeArtifactIntent = /(file|script|module|class|function|code|component|app|game|endpoint|api)/.test(normalized);
    const fileWriteIntent = /(write|save|append|create file|update file|modify file|edit file|persist|output file|artifact)/.test(normalized);
    const fileReadIntent = /(read|load|open file|list directory|directory|path|inspect file)/.test(normalized);
    const shellIntent = /(run|execute|test|build|install|lint|compile|command|terminal)/.test(normalized);
    const webIntent = /(research|search|look up|find online|web|internet|source)/.test(normalized);

    const requiresFileEffects = hasFileTool && (
        fileWriteIntent
        || (codingIntent && (codeArtifactIntent || hasExplicitFileReference))
    );
    const requiresShellEffects = shellIntent && hasShellTool;
    const requiresToolExecution = requiresFileEffects
        || requiresShellEffects
        || ((fileReadIntent && hasFileTool) || (webIntent && hasWebTool));

    return {
        requiresToolExecution,
        requiresFileEffects,
        requiresShellEffects,
    };
}

function verifyWorkerExecution(
    expectation: WorkerExecutionExpectation,
    attempted: number,
    succeeded: number,
    verifiedFileEffects: number,
    verifiedShellEffects: number,
): WorkerExecutionVerification {
    if (!expectation.requiresToolExecution) {
        return { ok: true, reason: "No tool execution required for this instruction." };
    }

    if (attempted <= 0) {
        return {
            ok: false,
            reason: "No tools were executed for a tool-dependent instruction.",
        };
    }

    if (succeeded <= 0) {
        return {
            ok: false,
            reason: "Tools were attempted but none succeeded.",
        };
    }

    if (expectation.requiresFileEffects && verifiedFileEffects <= 0) {
        return {
            ok: false,
            reason: "Instruction required file side effects, but no verified file write/append effects were produced.",
        };
    }

    if (expectation.requiresShellEffects && verifiedShellEffects <= 0) {
        return {
            ok: false,
            reason: "Instruction required shell execution side effects, but no verified shell execution effects were produced.",
        };
    }

    return { ok: true, reason: "Tool execution requirements satisfied." };
}

function normalizeUserUtterance(input: string): string {
    return input
        .toLowerCase()
        .replace(/[!?.,]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function hasNoActionableObjective(userMessage: string): boolean {
    const normalized = normalizeUserUtterance(userMessage);
    if (!normalized) return true;
    if (GREETING_ONLY_PATTERN.test(normalized)) return true;
    if (SMALL_TALK_ONLY_PATTERN.test(normalized)) return true;
    if (/^(hi|hello|hey|yo|sup|howdy)\b/.test(normalized) && normalized.split(" ").length <= 3) return true;
    return false;
}

function hasWebResearchCapability(worker: AgentConfig, mcpCapabilities: McpCapabilitySnapshot): boolean {
    const toolIds = worker.tools || [];
    return toolIds.includes("web_search")
        || toolIds.includes("search_internet")
        || (toolIds.includes("mcp_all") && mcpCapabilities.hasWebResearch);
}

function isLikelyBuildRequest(userMessage: string): boolean {
    const normalized = normalizeUserUtterance(userMessage);
    return /(build|make|create|implement|code|program|develop|ship|write|design|draft|plan|fix|refactor)/.test(normalized)
        || /(game|app|website|api|script|component|feature|project|tool)/.test(normalized);
}

function selectBestEffortWorker(
    runtime: SquadRuntime,
    userMessage: string,
    preferResearch: boolean,
    mcpCapabilities: McpCapabilitySnapshot,
): AgentConfig | null {
    const buildIntent = isLikelyBuildRequest(userMessage);
    const scored = runtime.workers.map((worker, index) => {
        const toolIds = worker.tools || [];
        const hasMcpAll = toolIds.includes("mcp_all");
        const hasWeb = hasWebResearchCapability(worker, mcpCapabilities);
        const hasFile = toolIds.includes("fs_write") || toolIds.includes("write_file")
            || toolIds.includes("fs_read") || toolIds.includes("read_file")
            || toolIds.includes("fs_list") || toolIds.includes("list_directory")
            || (hasMcpAll && mcpCapabilities.hasFileIo);
        const hasShell = toolIds.includes("shell_execute") || toolIds.includes("execute_command")
            || (hasMcpAll && mcpCapabilities.hasShell);
        const roleText = `${worker.name} ${worker.role} ${worker.description || ""}`.toLowerCase();
        const isResearchRole = /(research|analyst|investigat|fact|search)/.test(roleText);
        const isBuilderRole = /(engineer|developer|programmer|coder|architect|builder)/.test(roleText);

        let score = 0;
        if (toolIds.length > 0) score += 5;
        if (preferResearch && hasWeb) score += 60;
        if (preferResearch && isResearchRole) score += 30;
        if (buildIntent && (hasFile || hasShell)) score += 25;
        if (buildIntent && isBuilderRole) score += 15;
        if (buildIntent && hasWeb) score += 8;

        return { worker, index, score };
    });

    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.index - b.index;
    });

    return scored[0]?.worker || null;
}

function buildBestEffortInstruction(
    userMessage: string,
    preferResearch: boolean,
): string {
    const safeRequest = userMessage.trim() || "Proceed with the latest request.";
    const guidance = preferResearch
        ? "Start with a quick research pass to resolve unknowns, then produce concrete next steps or implementation output."
        : "If details are underspecified, pick sensible defaults and continue implementation.";

    return [
        `User request: ${safeRequest}`,
        "Proceed now with best-effort assumptions.",
        "Do not ask the user a clarifying question unless there is no actionable objective at all.",
        guidance,
    ].join(" ");
}

function normalizeDecision(input: Record<string, unknown>): DirectorDecision | null {
    const status = String(input.status ?? "").trim().toLowerCase();
    const summary = String(input.summary ?? "").trim();

    if (!summary) return null;
    if (!["continue", "complete", "needs_user_input", "blocked"].includes(status)) return null;

    const readStringField = (key: string): string => (
        typeof input[key] === "string" ? String(input[key]).trim() : ""
    );

    if (status === "continue") {
        const targetAgentId = readStringField("targetAgentId");
        const instruction = readStringField("instruction");
        if (!targetAgentId || !instruction) return null;
        return {
            status: "continue",
            summary,
            targetAgentId,
            instruction,
        };
    }

    if (status === "complete") {
        const responseToUser = readStringField("responseToUser");
        if (!responseToUser) return null;
        return {
            status: "complete",
            summary,
            responseToUser,
        };
    }

    if (status === "needs_user_input") {
        const userQuestion = readStringField("userQuestion");
        if (!userQuestion) return null;
        return {
            status: "needs_user_input",
            summary,
            userQuestion,
        };
    }

    const blockerReason = readStringField("blockerReason");
    if (!blockerReason) return null;
    return {
        status: "blocked",
        summary,
        blockerReason,
    };
}

function defaultModelForProvider(providerId: string): string {
    return PROVIDERS.find((provider) => provider.id === providerId)?.defaultModel
        || DEFAULT_SQUAD_ORCHESTRATOR_PROFILE.model;
}

function sanitizeSquadFolderName(name: string): string {
    const safe = name.toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    return safe || "default-squad";
}

function hasProviderApiKey(apiKeys: AgentApiKeys, providerId: string): boolean {
    if (!apiKeys) return false;
    if (typeof apiKeys === "string") return providerId === "groq" && apiKeys.trim().length > 0;
    const value = apiKeys[providerId];
    return typeof value === "string" && value.trim().length > 0;
}

function isResponseFormatSupportError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    return normalized.includes("response_format")
        || normalized.includes("json_schema")
        || normalized.includes("structured output")
        || normalized.includes("strict")
        || normalized.includes("schema");
}

function truncateForDebug(input: string, maxLength: number = 2500): string {
    if (input.length <= maxLength) return input;
    const suffix = `... [truncated ${input.length - maxLength} chars]`;
    return `${input.slice(0, maxLength)}${suffix}`;
}

function normalizeWhitespaceForDebug(input: string): string {
    return input.replace(/\s+/g, " ").trim();
}

function errorToDebugString(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

function isGroqStrictOrchestratorModel(modelId: string): boolean {
    const normalized = modelId.trim().toLowerCase();
    return normalized === "gpt-oss-20b"
        || normalized === "gpt-oss-120b"
        || normalized === "openai/gpt-oss-20b"
        || normalized === "openai/gpt-oss-120b";
}

export class SquadOrchestrator {
    constructor(
        private readonly availableAgents: AgentConfig[],
        private readonly availableTools: Tool[],
        private readonly apiKeys: AgentApiKeys,
        private readonly debugLog?: OrchestratorDebugLogFn,
    ) { }

    private emitDebug(message: string, data?: unknown): void {
        if (!this.debugLog) return;
        this.debugLog(message, data);
    }

    private resolveOrchestratorProfile(
        config: SquadConfig,
        workers: AgentConfig[],
    ): SquadOrchestratorProfile {
        const configured = {
            ...DEFAULT_SQUAD_ORCHESTRATOR_PROFILE,
            ...(config.orchestrator ?? {}),
        };

        const preferredProviders = [
            configured.provider,
            ...workers.map((agent) => agent.provider || "").filter((id) => id.length > 0),
        ];
        const uniquePreferredProviders = Array.from(new Set(preferredProviders));
        const providerFromPreferred = uniquePreferredProviders.find((providerId) => hasProviderApiKey(this.apiKeys, providerId));
        const providerFromAnyKey = PROVIDERS
            .map((provider) => provider.id)
            .find((providerId) => hasProviderApiKey(this.apiKeys, providerId));
        const resolvedProvider = providerFromPreferred
            || providerFromAnyKey
            || configured.provider
            || DEFAULT_SQUAD_ORCHESTRATOR_PROFILE.provider;

        const modelFromWorkers = workers.find((agent) => (agent.provider || DEFAULT_SQUAD_ORCHESTRATOR_PROFILE.provider) === resolvedProvider)?.model;
        const requestedModel = configured.model
            || modelFromWorkers
            || defaultModelForProvider(resolvedProvider);
        const resolvedModel = resolvedProvider === "groq"
            ? (isGroqStrictOrchestratorModel(requestedModel) ? requestedModel : GROQ_STRICT_ORCHESTRATOR_DEFAULT_MODEL)
            : requestedModel;

        return {
            name: configured.name || DEFAULT_SQUAD_ORCHESTRATOR_PROFILE.name,
            provider: resolvedProvider,
            model: resolvedModel,
            style: configured.style || DEFAULT_SQUAD_ORCHESTRATOR_PROFILE.style,
            voiceId: configured.voiceId || DEFAULT_SQUAD_ORCHESTRATOR_PROFILE.voiceId,
        };
    }

    private getRuntime(config: SquadConfig): SquadRuntime {
        const normalized = normalizeSquadConfig(config);
        const workers = normalized.members
            .map((id) => this.availableAgents.find((agent) => agent.id === id))
            .filter((agent): agent is AgentConfig => Boolean(agent));

        if (workers.length === 0) {
            throw new Error(`Squad '${normalized.name}' has no worker agents.`);
        }

        const orchestrator = this.resolveOrchestratorProfile(normalized, workers);
        return { config: normalized, workers, orchestrator };
    }

    private supportsDirectorStrictJson(runtime: SquadRuntime): boolean {
        const providerId = (runtime.orchestrator.provider || "").trim().toLowerCase();
        // Groq supports strict JSON schema mode where available; attempt it for all Groq models
        // and rely on runtime fallback when a specific model rejects response_format.
        return providerId === "groq";
    }

    private getDirectorResponseFormat(runtime: SquadRuntime): LLMResponseFormat | undefined {
        if (!this.supportsDirectorStrictJson(runtime)) {
            const providerId = (runtime.orchestrator.provider || "").trim().toLowerCase();
            if (providerId === "openai") {
                return { type: "json_object" };
            }
            return undefined;
        }

        return {
            type: "json_schema",
            json_schema: {
                name: "squad_orchestrator_director_decision",
                strict: true,
                schema: DIRECTOR_DECISION_RESPONSE_SCHEMA,
            },
        };
    }

    private async runDirectorChat(
        llm: LLMClient,
        runtime: SquadRuntime,
        messages: LLMMessage[],
        options: LLMChatOptions,
    ): Promise<LLMResponse> {
        const responseFormat = this.getDirectorResponseFormat(runtime);
        this.emitDebug("Orchestrator director LLM request", {
            provider: runtime.orchestrator.provider,
            model: runtime.orchestrator.model,
            responseFormat: responseFormat?.type || "none",
            strictJsonRequested: Boolean(
                responseFormat
                && responseFormat.type === "json_schema"
                && responseFormat.json_schema.strict === true,
            ),
            messageCount: messages.length,
            maxTokens: options.max_tokens ?? null,
            temperature: options.temperature ?? null,
        });
        if (!responseFormat) {
            return llm.chat(messages, options);
        }

        try {
            return await llm.chat(messages, {
                ...options,
                responseFormat,
            });
        } catch (error: unknown) {
            if (!isResponseFormatSupportError(error)) {
                throw error;
            }
            this.emitDebug("Orchestrator response_format request rejected; retrying with fallback", {
                provider: runtime.orchestrator.provider,
                model: runtime.orchestrator.model,
                requestedResponseFormat: responseFormat.type,
                error: errorToDebugString(error),
            });

            // If strict schema failed, attempt JSON object mode before dropping response_format.
            if (responseFormat.type === "json_schema") {
                try {
                    return await llm.chat(messages, {
                        ...options,
                        responseFormat: { type: "json_object" },
                    });
                } catch (fallbackError: unknown) {
                    if (!isResponseFormatSupportError(fallbackError)) {
                        throw fallbackError;
                    }
                    this.emitDebug("Orchestrator json_object fallback rejected; retrying without response_format", {
                        provider: runtime.orchestrator.provider,
                        model: runtime.orchestrator.model,
                        error: errorToDebugString(fallbackError),
                    });
                }
            }

            return llm.chat(messages, options);
        }
    }

    private getDirectorPrompt(runtime: SquadRuntime): string {
        const interaction = getSquadInteractionConfig(runtime.config);
        const goal = getSquadGoal(runtime.config);
        const context = getSquadContext(runtime.config);
        const workspaceFolder = `Squads/${sanitizeSquadFolderName(runtime.config.name)}`;
        const mcpCapabilities = buildMcpCapabilitySnapshot(this.availableTools);
        const workers = runtime.workers.map((agent) => {
            const tools = agent.tools && agent.tools.length > 0 ? agent.tools.join(", ") : "No tools";
            const capabilities = inferToolCapabilities(agent.tools || [], mcpCapabilities);
            const style = agent.style || "assistant";
            const capabilitySummary = capabilities.length > 0 ? capabilities.join(", ") : "none";
            return `- ${agent.id}: ${agent.name} (${agent.role}, style=${style}) | Tools: ${tools} | Capabilities: ${capabilitySummary}`;
        }).join("\n");
        const workerIds = runtime.workers
            .map((agent) => (agent.id || "").trim())
            .filter((id): id is string => id.length > 0)
            .join(", ");

        const interactionInstructions = interaction.mode === "live_campaign"
            ? [
                "Interaction mode is LIVE CAMPAIGN.",
                "Run tight turn-taking: one speaking worker per turn unless fast interjections are needed.",
                "Keep non-user character responses concise (generally 2-6 sentences). Avoid unprompted monologues.",
                "Use the user as the primary player POV. Ask for user input at decision points that affect agency or fun.",
                "If a DM/Narrator worker exists, treat that role as scene controller and avoid exposing hidden campaign notes to the user.",
            ]
            : [
                "Interaction mode is MASTER LOG.",
                "Optimize for practical outcomes and concise progress toward completion.",
                "Use specialized workers for the right subtask instead of rotating blindly.",
                "Prefer targeted edits to existing files instead of rewriting unaffected files.",
            ];

        if (interaction.userTurnPolicy === "every_round") {
            interactionInstructions.push(
                "User turn policy is EVERY ROUND: after one meaningful worker action, prefer asking user what happens next.",
            );
        } else {
            interactionInstructions.push(
                "User turn policy is ON DEMAND: continue autonomously until a real dependency on user choice appears.",
            );
        }

        return `You are ${runtime.orchestrator.name}, the built-in orchestrator for squad "${runtime.config.name}".

Squad goal:
${goal || "No explicit goal provided."}

Squad context:
${context || "No extra context provided."}

You route work to specialist workers and decide when the user should act.
Available worker agents:
${workers}
Valid targetAgentId values (exact match only):
${workerIds || "(none)"}

Execution strategy:
1. Choose the most relevant worker for the current subproblem.
2. Use tool-capable workers when setup or persistent artifacts are needed.
3. If persistent shared context is needed, direct workers to write focused files under "${workspaceFolder}" (for example: campaign.md, plan.md, notes.md).
4. Early in a run, prefer a lightweight setup pass when it will reduce confusion later.
5. Keep worker prompts precise, scoped, and role-aware.
6. In live campaign mode, keep pacing responsive and leave space for user actions.
7. Match task type to worker capabilities (for example: file-io, shell, web-research).
8. For large artifacts, require incremental file writes in chunks instead of one giant write.
9. For feature changes, inspect existing files first and patch only affected sections.
10. Avoid full project regeneration unless the user explicitly requests a rewrite.

Return ONLY valid JSON with this exact schema:
{
  "status": "continue" | "complete" | "needs_user_input" | "blocked",
  "summary": "short rationale for this decision",
  "targetAgentId": "required when status=continue",
  "instruction": "required when status=continue",
  "responseToUser": "required when status=complete",
  "userQuestion": "required when status=needs_user_input",
  "blockerReason": "required when status=blocked"
}

Rules:
1. Choose status="continue" when a worker should act next.
2. Choose status="complete" only when the user-ready output is done.
3. If the objective is clear but details are missing, choose status="continue" and proceed with reasonable assumptions.
4. Choose status="needs_user_input" only when there is no actionable objective (for example, greeting/small talk with no task).
5. If uncertainty is factual and a web-research worker exists, route to that worker instead of asking the user.
6. Choose status="blocked" only for hard constraints.
7. Never assign work to yourself.
8. If status="continue", targetAgentId must be exactly one id from "Valid targetAgentId values".
9. Output exactly one JSON object only. No prose, no markdown, no code fences, no JavaScript string concatenation.

Interaction constraints:
${interactionInstructions.map((line, index) => `${index + 1}. ${line}`).join("\n")}`;
    }

    private async getDirectorDecision(
        runtime: SquadRuntime,
        userMessage: string,
        history: Message[],
        workLog: string[],
    ): Promise<DirectorDecision> {
        const directorAgent = new Agent({
            id: "__squad_orchestrator__",
            name: runtime.orchestrator.name,
            role: "Squad Orchestrator",
            systemPrompt: "Coordinate specialized workers and manage user involvement intelligently.",
            provider: runtime.orchestrator.provider,
            model: runtime.orchestrator.model,
            tools: [],
        });
        const llm = directorAgent.getLLMClient(this.apiKeys);

        const conversationContext = history
            .slice(-DIRECTOR_HISTORY_LIMIT)
            .map((msg) => `${msg.role.toUpperCase()}${msg.name ? ` (${msg.name})` : ""}: ${msg.content}`)
            .join("\n\n");

        const contextPayload = [
            `Latest user request:\n${userMessage}`,
            `Recent conversation context:\n${conversationContext || "None."}`,
            `Completed worker outputs:\n${toStringArray(workLog)}`,
        ].join("\n\n");

        this.emitDebug("Orchestrator preparing director decision context", {
            userMessagePreview: truncateForDebug(userMessage, 500),
            historyMessages: history.length,
            workLogEntries: workLog.length,
            provider: runtime.orchestrator.provider,
            model: runtime.orchestrator.model,
            strictJsonEligible: this.supportsDirectorStrictJson(runtime),
        });

        const raw = await this.runDirectorChat(
            llm,
            runtime,
            [
                { role: "system", content: this.getDirectorPrompt(runtime) },
                { role: "user", content: contextPayload },
            ],
            { max_tokens: 1200, temperature: 0.2 },
        );
        this.emitDebug("Orchestrator raw decision payload received", {
            contentLength: raw.content.length,
            newlineCount: (raw.content.match(/\n/g) || []).length,
            contentPreview: truncateForDebug(normalizeWhitespaceForDebug(raw.content), 1000),
        });

        const parsed = extractJsonObject(raw.content);
        if (!parsed) {
            this.emitDebug("Orchestrator decision parse failed", {
                reason: "extractJsonObject returned null",
                rawPayloadPreview: truncateForDebug(normalizeWhitespaceForDebug(raw.content), 1000),
            });
            const corrected = await this.requestDirectorCorrection(
                llm,
                runtime,
                contextPayload,
                raw.content || "",
                "Failed to parse decision payload into a JSON object.",
            );
            return corrected;
        }
        this.emitDebug("Orchestrator parsed decision payload", parsed);

        const normalized = normalizeDecision(parsed);
        if (!normalized) {
            this.emitDebug("Orchestrator decision schema validation failed", {
                parsedPayload: parsed,
                reason: "normalizeDecision returned null",
            });
            const corrected = await this.requestDirectorCorrection(
                llm,
                runtime,
                contextPayload,
                raw.content || "",
                "Missing required decision fields or status-specific schema fields.",
            );
            return corrected;
        }

        const runtimeValidationError = this.getDirectorDecisionRuntimeValidationError(runtime, normalized);
        if (runtimeValidationError) {
            this.emitDebug("Orchestrator decision runtime validation failed", {
                validationError: runtimeValidationError,
                decision: normalized,
            });
            const corrected = await this.requestDirectorCorrection(
                llm,
                runtime,
                contextPayload,
                raw.content || "",
                runtimeValidationError,
            );
            return corrected;
        }

        this.emitDebug("Orchestrator decision accepted", normalized);
        return normalized;
    }

    private getDirectorDecisionRuntimeValidationError(
        runtime: SquadRuntime,
        decision: DirectorDecision,
    ): string | null {
        if (decision.status !== "continue") return null;

        const targetAgentId = (decision.targetAgentId || "").trim();
        const workerIds = new Set(
            runtime.workers
                .map((worker) => (worker.id || "").trim())
                .filter((id): id is string => id.length > 0),
        );

        if (!workerIds.has(targetAgentId)) {
            return `Invalid targetAgentId '${targetAgentId}'. Must exactly match a known worker id.`;
        }

        const instruction = (decision.instruction || "").trim();
        if (!instruction) {
            return "Missing instruction for status=continue.";
        }

        return null;
    }

    private async requestDirectorCorrection(
        llm: ReturnType<Agent["getLLMClient"]>,
        runtime: SquadRuntime,
        contextPayload: string,
        invalidDecisionText: string,
        errorReason: string,
    ): Promise<DirectorDecision> {
        const allowedIds = runtime.workers
            .map((worker) => (worker.id || "").trim())
            .filter((id): id is string => id.length > 0);
        const correctionPrompt = [
            "The previous orchestration JSON is invalid and must be corrected.",
            `Validation error: ${errorReason}`,
            `Allowed targetAgentId values (exact): ${allowedIds.join(", ") || "(none)"}`,
            "Do not return prose, markdown, code fences, or JavaScript string concatenation.",
            "Return exactly one JSON object that begins with '{' and ends with '}'.",
            "Return corrected JSON only, using the exact required schema.",
        ].join("\n");
        this.emitDebug("Orchestrator requesting correction", {
            errorReason,
            invalidDecisionPreview: truncateForDebug(normalizeWhitespaceForDebug(invalidDecisionText), 1000),
            allowedTargetAgentIds: allowedIds,
        });

        const correctedRaw = await this.runDirectorChat(
            llm,
            runtime,
            [
                { role: "system", content: this.getDirectorPrompt(runtime) },
                { role: "user", content: contextPayload },
                { role: "assistant", content: invalidDecisionText },
                { role: "user", content: correctionPrompt },
            ],
            { max_tokens: 1200, temperature: 0.1 },
        );
        this.emitDebug("Orchestrator raw correction payload received", {
            contentLength: correctedRaw.content.length,
            newlineCount: (correctedRaw.content.match(/\n/g) || []).length,
            contentPreview: truncateForDebug(normalizeWhitespaceForDebug(correctedRaw.content), 1000),
        });

        const correctedParsed = extractJsonObject(correctedRaw.content);
        if (!correctedParsed) {
            this.emitDebug("Orchestrator correction parse failed", {
                reason: "extractJsonObject returned null",
                rawPayloadPreview: truncateForDebug(normalizeWhitespaceForDebug(correctedRaw.content), 1000),
            });
            return {
                status: "blocked",
                summary: "Orchestrator correction payload was invalid JSON.",
                blockerReason: errorReason,
            };
        }
        this.emitDebug("Orchestrator parsed correction payload", correctedParsed);

        const correctedDecision = normalizeDecision(correctedParsed);
        if (!correctedDecision) {
            this.emitDebug("Orchestrator correction schema validation failed", {
                parsedPayload: correctedParsed,
                reason: "normalizeDecision returned null",
            });
            return {
                status: "blocked",
                summary: "Orchestrator correction payload failed schema validation.",
                blockerReason: errorReason,
            };
        }

        const correctedValidationError = this.getDirectorDecisionRuntimeValidationError(runtime, correctedDecision);
        if (correctedValidationError) {
            this.emitDebug("Orchestrator correction runtime validation failed", {
                validationError: correctedValidationError,
                decision: correctedDecision,
            });
            return {
                status: "blocked",
                summary: "Orchestrator correction payload failed runtime validation.",
                blockerReason: correctedValidationError,
            };
        }

        this.emitDebug("Orchestrator correction accepted", correctedDecision);
        return correctedDecision;
    }

    private applyBestEffortDecisionFallback(
        runtime: SquadRuntime,
        userMessage: string,
        decision: DirectorDecision,
        workLog: string[],
    ): DirectorDecision {
        if (decision.status !== "needs_user_input") {
            return decision;
        }

        if (hasNoActionableObjective(userMessage)) {
            return decision;
        }

        const uncertaintyText = `${decision.summary} ${decision.userQuestion || ""}`.toLowerCase();
        const uncertaintySignals = /(more information|missing info|unclear|unknown|details|requirements|preferences|target platform)/;
        const mcpCapabilities = buildMcpCapabilitySnapshot(this.availableTools);
        const hasResearchWorker = runtime.workers.some((worker) => hasWebResearchCapability(worker, mcpCapabilities));
        const preferResearch = hasResearchWorker && (
            workLog.length === 0
            || uncertaintySignals.test(uncertaintyText)
        );

        const fallbackWorker = selectBestEffortWorker(runtime, userMessage, preferResearch, mcpCapabilities);
        if (!fallbackWorker || !fallbackWorker.id) {
            return decision;
        }

        return {
            status: "continue",
            summary: "Proceeding with best-effort execution instead of requesting more user input.",
            targetAgentId: fallbackWorker.id,
            instruction: buildBestEffortInstruction(userMessage, preferResearch),
        };
    }

    private buildWorkerTask(
        runtime: SquadRuntime,
        userMessage: string,
        instruction: string,
        workLog: string[],
        worker: AgentConfig,
        workspaceRoot: string,
        workspaceArtifactsDir: string,
    ): string {
        const interaction = getSquadInteractionConfig(runtime.config);
        const goal = getSquadGoal(runtime.config);
        const context = getSquadContext(runtime.config);
        const previousOutputs = toStringArray(workLog);
        const workspaceFolder = `Squads/${sanitizeSquadFolderName(runtime.config.name)}`;
        const toolIds = worker.tools || [];
        const mcpCapabilities = buildMcpCapabilitySnapshot(this.availableTools);
        const capabilitySummary = inferToolCapabilities(toolIds, mcpCapabilities);
        const hasMcpAll = toolIds.includes("mcp_all");
        const hasFileWrite = toolIds.includes("fs_write")
            || toolIds.includes("write_file")
            || (hasMcpAll && mcpCapabilities.hasFileWrite);
        const hasNativeFsWrite = toolIds.includes("fs_write") || toolIds.includes("write_file");
        const styleGuidance = interaction.mode === "live_campaign"
            ? [
                "Respond scene-ready and stay in character if your role implies it.",
                "Keep your turn concise (usually 2-6 sentences) unless the instruction asks for more.",
                "Avoid long monologues so the user can respond frequently.",
                "If you are world-controller/DM-like, reveal only what characters can perceive.",
            ].join("\n")
            : [
                "Focus on practical execution output.",
                `If creating persistent artifacts, use concise files under "${workspaceFolder}".`,
                `Your agent workspace root is "${workspaceRoot}".`,
                `Prefer writing generated artifacts under "${workspaceArtifactsDir}" unless the instruction requires another path.`,
                "Write only what the orchestrator needs next.",
                "Prefer editing existing files in place over rewriting full files.",
            ].join("\n");
        const writeConstraint = hasFileWrite && hasNativeFsWrite
            ? [
                "If a file is large, write it incrementally.",
                "Use fs_write mode=\"overwrite\" for the first chunk and mode=\"append\" for later chunks.",
                "Keep chunks compact (recommended <= 2000 chars per chunk).",
                "If a target file already exists, read it first and preserve existing valid content unless explicitly asked to replace it.",
                "Always set fs_write mode explicitly; do not rely on implicit defaults.",
                "When changing a feature, patch the smallest relevant sections and preserve unrelated code.",
            ].join("\n")
            : hasFileWrite
                ? [
                    "Use the MCP filesystem write/edit tools for persistent artifacts.",
                    "Match arguments to each tool schema exactly (for example, path/content fields).",
                    "If writing large content, prefer multiple smaller writes over one giant write.",
                    "Read existing files before replacing content unless full replacement is explicitly requested.",
                    "When changing a feature, patch existing files and avoid regenerating unrelated files.",
                ].join("\n")
                : "Do not assume file-writing access if no write-capable tool is available.";

        return `You are part of squad "${runtime.config.name}".
Goal: ${goal || "No explicit goal provided."}
Context: ${context || "No extra context provided."}
Your tool capabilities: ${capabilitySummary.length > 0 ? capabilitySummary.join(", ") : "none"}

User request:
${userMessage}

Orchestrator instruction:
${instruction}

Prior worker outputs:
${previousOutputs}

Produce only the requested deliverable for the orchestrator.
${styleGuidance}
${writeConstraint}`;
    }

    public async run(
        config: SquadConfig,
        history: Message[],
        userMessage: string,
        onStep?: (step: SquadRunStep, stepsSnapshot: SquadRunStep[]) => void | Promise<void>,
        options?: SquadRunOptions,
    ): Promise<SquadRunResult> {
        const runtime = this.getRuntime(config);
        const interaction = getSquadInteractionConfig(runtime.config);
        const mcpCapabilities = buildMcpCapabilitySnapshot(this.availableTools);
        const toolAccessMode: AccessPermissionMode = runtime.config.accessMode === "full_access" ? "full_access" : "ask_always";
        const toolAccessGranted = options?.toolAccessGranted === true;
        const steps: SquadRunStep[] = [];
        const workLog: string[] = [];
        const maxIterations = Math.max(1, runtime.config.maxIterations || DEFAULT_MAX_ITERATIONS);
        const emitStep = async (step: SquadRunStep) => {
            if (!onStep) return;
            await onStep(step, [...steps]);
        };

        for (let iteration = 1; iteration <= maxIterations; iteration++) {
            const directorDecision = await this.getDirectorDecision(runtime, userMessage, history, workLog);
            const decision = this.applyBestEffortDecisionFallback(runtime, userMessage, directorDecision, workLog);
            const step: SquadRunStep = { iteration, directorDecision: decision };

            if (decision.status === "complete") {
                steps.push(step);
                await emitStep(step);
                return {
                    status: "completed",
                    response: decision.responseToUser || decision.summary,
                    steps,
                };
            }

            if (decision.status === "needs_user_input") {
                steps.push(step);
                await emitStep(step);
                return {
                    status: "needs_user_input",
                    response: decision.userQuestion || "I need more information before the squad can continue.",
                    steps,
                };
            }

            if (decision.status === "blocked") {
                steps.push(step);
                await emitStep(step);
                return {
                    status: "blocked",
                    response: decision.blockerReason || decision.summary,
                    steps,
                };
            }

            const worker = runtime.workers.find((agent) => agent.id === decision.targetAgentId);
            if (!worker || !decision.instruction) {
                step.directorDecision = {
                    status: "blocked",
                    summary: "Orchestrator selected an invalid worker assignment.",
                    blockerReason: "No valid targetAgentId/instruction was provided.",
                };
                steps.push(step);
                await emitStep(step);
                return {
                    status: "blocked",
                    response: step.directorDecision.blockerReason || step.directorDecision.summary,
                    steps,
                };
            }

            const workerAgent = new Agent(worker);
            const workerRunId = uuidv4();
            const workerWorkspace = await ensureAgentWorkspace(worker);
            const subAgentRuntime = new SubAgentRuntime({
                availableAgents: this.availableAgents,
                availableTools: this.availableTools,
                apiKeys: this.apiKeys,
                currentAgentId: worker.id,
                currentAgentName: worker.name,
                parentRunId: workerRunId,
                parentExecutionContext: {
                    squadId: runtime.config.id,
                    squadName: runtime.config.name,
                    runId: workerRunId,
                    toolAccessMode,
                    toolAccessGranted,
                    agentWorkspaceRoot: workerWorkspace.rootAbsolutePath,
                    agentWorkspaceRootRelative: workerWorkspace.rootRelativePath,
                    agentWorkspaceArtifactsDir: workerWorkspace.artifactsAbsolutePath,
                    agentWorkspaceArtifactsDirRelative: workerWorkspace.artifactsRelativePath,
                },
            });
            const workerExecutionContext = {
                squadId: runtime.config.id,
                squadName: runtime.config.name,
                runId: workerRunId,
                toolAccessMode,
                toolAccessGranted,
                agentWorkspaceRoot: workerWorkspace.rootAbsolutePath,
                agentWorkspaceRootRelative: workerWorkspace.rootRelativePath,
                agentWorkspaceArtifactsDir: workerWorkspace.artifactsAbsolutePath,
                agentWorkspaceArtifactsDirRelative: workerWorkspace.artifactsRelativePath,
                ...subAgentRuntime.createExecutionContext(),
            };
            const task = this.buildWorkerTask(
                runtime,
                userMessage,
                decision.instruction,
                workLog,
                worker,
                workerWorkspace.rootRelativePath,
                workerWorkspace.artifactsRelativePath,
            );
            const workerHistory: Message[] = [
                ...history.slice(-8),
                {
                    id: uuidv4(),
                    role: "user",
                    content: task,
                    timestamp: Date.now(),
                },
            ];

            const workerReply = await workerAgent.process(
                workerHistory,
                this.apiKeys,
                this.availableTools,
                workerExecutionContext,
            );
            let workerOutput = workerReply.content.trim();
            let workerToolExecution = workerReply.toolExecution ?? {
                attempted: 0,
                succeeded: 0,
                failed: 0,
                malformed: 0,
                verifiedFileEffects: 0,
                verifiedShellEffects: 0,
            };
            const executionExpectation = inferWorkerExecutionExpectation(decision.instruction, worker, mcpCapabilities);
            let executionVerification = verifyWorkerExecution(
                executionExpectation,
                workerToolExecution.attempted,
                workerToolExecution.succeeded,
                workerToolExecution.verifiedFileEffects,
                workerToolExecution.verifiedShellEffects,
            );

            if (!executionVerification.ok) {
                const retryHistory: Message[] = [
                    ...workerHistory,
                    workerReply,
                    {
                        id: uuidv4(),
                        role: "user",
                        content: `Validation failed: ${executionVerification.reason} Re-run the instruction and satisfy all required postconditions via actual tool calls before finalizing your response.`,
                        timestamp: Date.now(),
                    },
                ];

                const retryReply = await workerAgent.process(
                    retryHistory,
                    this.apiKeys,
                    this.availableTools,
                    workerExecutionContext,
                );
                workerOutput = retryReply.content.trim();
                workerToolExecution = retryReply.toolExecution ?? {
                    attempted: 0,
                    succeeded: 0,
                    failed: 0,
                    malformed: 0,
                    verifiedFileEffects: 0,
                    verifiedShellEffects: 0,
                };
                executionVerification = verifyWorkerExecution(
                    executionExpectation,
                    workerToolExecution.attempted,
                    workerToolExecution.succeeded,
                    workerToolExecution.verifiedFileEffects,
                    workerToolExecution.verifiedShellEffects,
                );
            }

            step.workerAgentId = worker.id;
            step.workerAgentName = worker.name;
            step.workerInstruction = decision.instruction;
            step.workerOutput = workerOutput;
            step.workerToolExecution = workerToolExecution;
            steps.push(step);
            await emitStep(step);

            if (!executionVerification.ok) {
                return {
                    status: "blocked",
                    response: `${worker.name} failed tool execution validation: ${executionVerification.reason}`,
                    steps,
                };
            }

            workLog.push(
                `[${worker.name}] Instruction: ${decision.instruction}\nOutput:\n${workerOutput}`,
            );

            if (interaction.userTurnPolicy === "every_round" && iteration < maxIterations) {
                return {
                    status: "needs_user_input",
                    response: `${worker.name} completed a turn. What do you do next?`,
                    steps,
                };
            }
        }

        return {
            status: "max_iterations",
            response: `The squad reached its iteration limit (${maxIterations}) before completion.`,
            steps,
        };
    }
}
