import { v4 as uuidv4 } from "uuid";
import { Agent, AgentApiKeys, AgentConfig } from "./Agent";
import { Message, Tool } from "./types";
import {
    DirectorDecision,
    SquadConfig,
    SquadRunResult,
    SquadRunStep,
    SquadRuntime,
    getSquadInteractionConfig,
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

export class SquadOrchestrator {
    constructor(
        private readonly availableAgents: AgentConfig[],
        private readonly availableTools: Tool[],
        private readonly apiKeys: AgentApiKeys,
    ) { }

    private getRuntime(config: SquadConfig): SquadRuntime {
        const director = this.availableAgents.find((a) => a.id === config.directorId);
        if (!director) {
            throw new Error(`Director not found for squad '${config.name}'.`);
        }

        const workers = config.members
            .map((id) => this.availableAgents.find((a) => a.id === id))
            .filter((a): a is AgentConfig => Boolean(a))
            .filter((a) => a.id !== director.id);

        if (workers.length === 0) {
            throw new Error(`Squad '${config.name}' has no worker agents.`);
        }

        return { config, director, workers };
    }

    private getDirectorPrompt(runtime: SquadRuntime): string {
        const interaction = getSquadInteractionConfig(runtime.config);
        const workers = runtime.workers.map((agent) => {
            const tools = agent.tools && agent.tools.length > 0 ? agent.tools.join(", ") : "No tools";
            return `- ${agent.id}: ${agent.name} (${agent.role}) | Tools: ${tools}`;
        }).join("\n");

        const interactionInstructions = interaction.mode === "live_campaign"
            ? [
                "Interaction mode is LIVE CAMPAIGN.",
                "Treat the director as a game master coordinating character turns.",
                "Keep outputs immersive and narrative-ready for direct chat display.",
            ]
            : [
                "Interaction mode is MASTER LOG.",
                "Optimize for efficient task completion and concise final deliverables.",
            ];

        if (interaction.userTurnPolicy === "every_round") {
            interactionInstructions.push(
                "User turn policy is EVERY ROUND: avoid long autonomous chains and prefer one meaningful worker turn before needing user input.",
            );
        }

        return `You are ${runtime.director.name}, the master director for squad "${runtime.config.name}".

Mission:
${runtime.config.mission}

You orchestrate workers and decide the next action.
Available worker agents:
${workers}

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
1. Choose status="continue" when more worker execution is needed.
2. Choose status="complete" only when final output is ready for the user.
3. Choose status="needs_user_input" if critical info is missing.
4. Choose status="blocked" only for hard limitations.
5. Keep summaries concise and actionable.
6. Never assign work to yourself.

Interaction constraints:
${interactionInstructions.map((line, index) => `${index + 1}. ${line}`).join("\n")}`;
    }

    private async getDirectorDecision(
        runtime: SquadRuntime,
        userMessage: string,
        history: Message[],
        workLog: string[],
    ): Promise<DirectorDecision> {
        const directorAgent = new Agent(runtime.director);
        const llm = directorAgent.getLLMClient(this.apiKeys);

        const conversationContext = history
            .slice(-DIRECTOR_HISTORY_LIMIT)
            .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
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
                summary: "Director returned invalid orchestration JSON.",
                blockerReason: "Failed to parse director decision payload.",
            };
        }

        const normalized = normalizeDecision(parsed);
        if (!normalized) {
            return {
                status: "blocked",
                summary: "Director decision schema was invalid.",
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
    ): string {
        const interaction = getSquadInteractionConfig(runtime.config);
        const previousOutputs = toStringArray(workLog);
        const styleGuidance = interaction.mode === "live_campaign"
            ? "Respond in-character where appropriate, with direct scene-ready output."
            : "Focus on practical execution output for the director.";

        return `You are part of squad "${runtime.config.name}".
Mission: ${runtime.config.mission}

User request:
${userMessage}

Director instruction:
${instruction}

Prior worker outputs:
${previousOutputs}

Produce only the deliverable needed for the director. Be concrete and concise.
${styleGuidance}`;
    }

    public async run(
        config: SquadConfig,
        history: Message[],
        userMessage: string,
    ): Promise<SquadRunResult> {
        const runtime = this.getRuntime(config);
        const interaction = getSquadInteractionConfig(config);
        const steps: SquadRunStep[] = [];
        const workLog: string[] = [];
        const maxIterations = Math.max(1, config.maxIterations || DEFAULT_MAX_ITERATIONS);

        for (let iteration = 1; iteration <= maxIterations; iteration++) {
            const decision = await this.getDirectorDecision(runtime, userMessage, history, workLog);
            const step: SquadRunStep = { iteration, directorDecision: decision };

            if (decision.status === "complete") {
                steps.push(step);
                return {
                    status: "completed",
                    response: decision.responseToUser || decision.summary,
                    steps,
                };
            }

            if (decision.status === "needs_user_input") {
                steps.push(step);
                return {
                    status: "needs_user_input",
                    response: decision.userQuestion || "I need more information before the squad can continue.",
                    steps,
                };
            }

            if (decision.status === "blocked") {
                steps.push(step);
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
                    summary: "Director selected an invalid worker assignment.",
                    blockerReason: "No valid targetAgentId/instruction was provided.",
                };
                steps.push(step);
                return {
                    status: "blocked",
                    response: step.directorDecision.blockerReason || step.directorDecision.summary,
                    steps,
                };
            }

            const workerAgent = new Agent(worker);
            const task = this.buildWorkerTask(runtime, userMessage, decision.instruction, workLog);
            const workerHistory: Message[] = [
                ...history.slice(-8),
                {
                    id: uuidv4(),
                    role: "user",
                    content: task,
                    timestamp: Date.now(),
                },
            ];

            const workerReply = await workerAgent.process(workerHistory, this.apiKeys, this.availableTools);
            const workerOutput = workerReply.content.trim();

            step.workerAgentId = worker.id;
            step.workerAgentName = worker.name;
            step.workerInstruction = decision.instruction;
            step.workerOutput = workerOutput;
            steps.push(step);

            workLog.push(
                `[${worker.name}] Instruction: ${decision.instruction}\nOutput:\n${workerOutput}`,
            );

            if (interaction.userTurnPolicy === "every_round" && iteration < maxIterations) {
                return {
                    status: "needs_user_input",
                    response: `${worker.name} finished a turn. Your move: tell the squad what happens next.`,
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
