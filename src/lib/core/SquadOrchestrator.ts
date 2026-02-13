import { v4 as uuidv4 } from "uuid";
import { PROVIDERS } from "../llm/constants";
import { Agent, AgentApiKeys, AgentConfig } from "./Agent";
import { Message, Tool } from "./types";
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

const DEFAULT_MAX_ITERATIONS = 6;
const DIRECTOR_HISTORY_LIMIT = 16;

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

function inferToolCapabilities(toolIds: string[]): string[] {
    const capabilities = new Set<string>();

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
    }

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

function inferWorkerExecutionExpectation(instruction: string, worker: AgentConfig): WorkerExecutionExpectation {
    const toolIds = worker.tools || [];
    if (toolIds.length === 0) {
        return {
            requiresToolExecution: false,
            requiresFileEffects: false,
            requiresShellEffects: false,
        };
    }

    const normalized = instruction.toLowerCase();
    const hasFileTool = toolIds.includes("fs_read") || toolIds.includes("fs_write") || toolIds.includes("fs_list")
        || toolIds.includes("read_file") || toolIds.includes("write_file") || toolIds.includes("list_directory");
    const hasShellTool = toolIds.includes("shell_execute") || toolIds.includes("execute_command");
    const hasWebTool = toolIds.includes("web_search") || toolIds.includes("search_internet");

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

function normalizeDecision(input: Record<string, unknown>): DirectorDecision | null {
    const status = String(input.status ?? "").trim().toLowerCase();
    const summary = String(input.summary ?? "").trim();

    if (!summary) return null;
    if (!["continue", "complete", "needs_user_input", "blocked"].includes(status)) return null;

    const decision: DirectorDecision = {
        status: status as DirectorDecision["status"],
        summary,
    };

    if (typeof input.targetAgentId === "string") decision.targetAgentId = input.targetAgentId;
    if (typeof input.instruction === "string") decision.instruction = input.instruction;
    if (typeof input.responseToUser === "string") decision.responseToUser = input.responseToUser;
    if (typeof input.userQuestion === "string") decision.userQuestion = input.userQuestion;
    if (typeof input.blockerReason === "string") decision.blockerReason = input.blockerReason;

    return decision;
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

export class SquadOrchestrator {
    constructor(
        private readonly availableAgents: AgentConfig[],
        private readonly availableTools: Tool[],
        private readonly apiKeys: AgentApiKeys,
    ) { }

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
        const resolvedModel = configured.model
            || modelFromWorkers
            || defaultModelForProvider(resolvedProvider);

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

    private getDirectorPrompt(runtime: SquadRuntime): string {
        const interaction = getSquadInteractionConfig(runtime.config);
        const goal = getSquadGoal(runtime.config);
        const context = getSquadContext(runtime.config);
        const workspaceFolder = `Squads/${sanitizeSquadFolderName(runtime.config.name)}`;
        const workers = runtime.workers.map((agent) => {
            const tools = agent.tools && agent.tools.length > 0 ? agent.tools.join(", ") : "No tools";
            const capabilities = inferToolCapabilities(agent.tools || []);
            const style = agent.style || "assistant";
            const capabilitySummary = capabilities.length > 0 ? capabilities.join(", ") : "none";
            return `- ${agent.id}: ${agent.name} (${agent.role}, style=${style}) | Tools: ${tools} | Capabilities: ${capabilitySummary}`;
        }).join("\n");

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

Execution strategy:
1. Choose the most relevant worker for the current subproblem.
2. Use tool-capable workers when setup or persistent artifacts are needed.
3. If persistent shared context is needed, direct workers to write focused files under "${workspaceFolder}" (for example: campaign.md, plan.md, notes.md).
4. Early in a run, prefer a lightweight setup pass when it will reduce confusion later.
5. Keep worker prompts precise, scoped, and role-aware.
6. In live campaign mode, keep pacing responsive and leave space for user actions.
7. Match task type to worker capabilities (for example: file-io, shell, web-research).
8. For large artifacts, require incremental file writes in chunks instead of one giant write.

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
3. Choose status="needs_user_input" only when missing info or user choice is truly required.
4. Choose status="blocked" only for hard constraints.
5. Never assign work to yourself.

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

        const raw = await llm.chat(
            [
                { role: "system", content: this.getDirectorPrompt(runtime) },
                { role: "user", content: contextPayload },
            ],
            { max_tokens: 1200, temperature: 0.2 },
        );

        const parsed = extractJsonObject(raw.content);
        if (!parsed) {
            return {
                status: "blocked",
                summary: "Orchestrator returned invalid orchestration JSON.",
                blockerReason: "Failed to parse orchestrator decision payload.",
            };
        }

        const normalized = normalizeDecision(parsed);
        if (!normalized) {
            return {
                status: "blocked",
                summary: "Orchestrator decision schema was invalid.",
                blockerReason: "Missing required decision fields.",
            };
        }

        return normalized;
    }

    private buildWorkerTask(
        runtime: SquadRuntime,
        userMessage: string,
        instruction: string,
        workLog: string[],
        worker: AgentConfig,
    ): string {
        const interaction = getSquadInteractionConfig(runtime.config);
        const goal = getSquadGoal(runtime.config);
        const context = getSquadContext(runtime.config);
        const previousOutputs = toStringArray(workLog);
        const workspaceFolder = `Squads/${sanitizeSquadFolderName(runtime.config.name)}`;
        const toolIds = worker.tools || [];
        const capabilitySummary = inferToolCapabilities(toolIds);
        const hasFileWrite = toolIds.includes("fs_write") || toolIds.includes("write_file");
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
                "Write only what the orchestrator needs next.",
            ].join("\n");
        const writeConstraint = hasFileWrite
            ? [
                "If a file is large, write it incrementally.",
                "Use fs_write mode=\"overwrite\" for the first chunk and mode=\"append\" for later chunks.",
                "Keep chunks compact (recommended <= 2000 chars per chunk).",
                "If a target file already exists, read it first and preserve existing valid content unless explicitly asked to replace it.",
                "Always set fs_write mode explicitly; do not rely on implicit defaults.",
            ].join("\n")
            : "Do not assume file-writing access if fs_write is unavailable.";

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
    ): Promise<SquadRunResult> {
        const runtime = this.getRuntime(config);
        const interaction = getSquadInteractionConfig(runtime.config);
        const steps: SquadRunStep[] = [];
        const workLog: string[] = [];
        const maxIterations = Math.max(1, runtime.config.maxIterations || DEFAULT_MAX_ITERATIONS);
        const emitStep = async (step: SquadRunStep) => {
            if (!onStep) return;
            await onStep(step, [...steps]);
        };

        for (let iteration = 1; iteration <= maxIterations; iteration++) {
            const decision = await this.getDirectorDecision(runtime, userMessage, history, workLog);
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
            const task = this.buildWorkerTask(runtime, userMessage, decision.instruction, workLog, worker);
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
                {
                    squadId: runtime.config.id,
                    squadName: runtime.config.name,
                },
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
            const executionExpectation = inferWorkerExecutionExpectation(decision.instruction, worker);
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
                    {
                        squadId: runtime.config.id,
                        squadName: runtime.config.name,
                    },
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
