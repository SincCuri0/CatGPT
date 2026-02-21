import { v4 as uuidv4 } from "uuid";
import { Agent, AgentApiKeys, AgentConfig } from "../Agent";
import { SubAgentRunState, SubAgentSpawnRequest, Tool, ToolExecutionContext } from "../types";
import { subAgentCoordinator } from "./SubAgentCoordinator";
import { clampTimeoutMs, subAgentRuntimeConfig } from "./config";
import { ensureAgentWorkspace } from "../agentWorkspace";

interface SubAgentRuntimeOptions {
    availableAgents: AgentConfig[];
    availableTools: Tool[];
    apiKeys: AgentApiKeys;
    currentAgentId?: string;
    currentAgentName?: string;
    parentRunId?: string;
    parentExecutionContext?: ToolExecutionContext;
    depth?: number;
    maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 2;

function cloneAgentConfig(agent: AgentConfig): AgentConfig {
    return {
        ...agent,
        tools: Array.isArray(agent.tools) ? [...agent.tools] : [],
    };
}

function chooseTargetAgent(
    request: SubAgentSpawnRequest,
    agents: AgentConfig[],
    currentAgentId?: string,
): AgentConfig | null {
    if (agents.length === 0) return null;

    if (request.agentId) {
        return agents.find((agent) => agent.id === request.agentId) || null;
    }

    const firstNonCurrent = agents.find((agent) => agent.id && agent.id !== currentAgentId);
    return firstNonCurrent || null;
}

function buildSubAgentTaskPrompt(parentAgentName: string, task: string): string {
    return [
        `You were spawned by parent agent '${parentAgentName}'.`,
        "Use only the focused task context below; do not assume access to the full parent chat transcript.",
        "Execute the task directly and return concise operational output.",
        "If you used tools, summarize what changed and reference concrete artifacts.",
        "Do not ask the user questions unless execution is blocked.",
        "",
        "Task:",
        task,
    ].join("\n");
}

export class SubAgentRuntime {
    private readonly depth: number;
    private readonly maxDepth: number;

    constructor(private readonly options: SubAgentRuntimeOptions) {
        this.depth = options.depth ?? 0;
        this.maxDepth = options.maxDepth ?? subAgentRuntimeConfig.maxDepth ?? DEFAULT_MAX_DEPTH;
    }

    public createExecutionContext(): Pick<ToolExecutionContext, "spawnSubAgent" | "awaitSubAgentRun" | "listSubAgentRuns" | "cancelSubAgentRun"> {
        return {
            spawnSubAgent: async (request) => this.spawnSubAgent(request),
            awaitSubAgentRun: async (runId, timeoutMs) => {
                if (!this.options.parentRunId) return null;
                const scoped = await subAgentCoordinator.getRun(runId);
                if (!scoped || scoped.parentRunId !== this.options.parentRunId) {
                    return null;
                }

                const awaited = await subAgentCoordinator.awaitRun(runId, clampTimeoutMs(timeoutMs));
                if (!awaited || awaited.parentRunId !== this.options.parentRunId) {
                    return null;
                }

                return awaited;
            },
            listSubAgentRuns: async () => {
                if (!this.options.parentRunId) return [];
                return subAgentCoordinator.listRuns(
                    this.options.parentRunId,
                    subAgentRuntimeConfig.maxListedRuns,
                );
            },
            cancelSubAgentRun: async (runId, reason) => {
                if (!this.options.parentRunId) return null;
                const run = await subAgentCoordinator.getRun(runId);
                if (!run || run.parentRunId !== this.options.parentRunId) {
                    return null;
                }

                return subAgentCoordinator.cancelRun(runId, reason || "Sub-agent run cancelled by parent agent.");
            },
        };
    }

    private async spawnSubAgent(request: SubAgentSpawnRequest): Promise<SubAgentRunState> {
        if (!this.options.parentRunId) {
            return {
                runId: uuidv4(),
                status: "failed",
                agentId: request.agentId || "unknown-agent",
                agentName: request.agentId || "unknown-agent",
                task: request.task,
                createdAt: Date.now(),
                finishedAt: Date.now(),
                error: "Sub-agent runtime is missing a parent run context.",
            };
        }

        const task = request.task.trim();
        if (!task) {
            return {
                runId: uuidv4(),
                parentRunId: this.options.parentRunId,
                status: "failed",
                agentId: request.agentId || "unknown-agent",
                agentName: request.agentId || "unknown-agent",
                task: request.task,
                createdAt: Date.now(),
                finishedAt: Date.now(),
                error: "Sub-agent task is empty.",
            };
        }

        if (task.length > subAgentRuntimeConfig.maxTaskChars) {
            return {
                runId: uuidv4(),
                parentRunId: this.options.parentRunId,
                status: "failed",
                agentId: request.agentId || "unknown-agent",
                agentName: request.agentId || "unknown-agent",
                task,
                createdAt: Date.now(),
                finishedAt: Date.now(),
                error: `Sub-agent task exceeds max length (${subAgentRuntimeConfig.maxTaskChars} chars).`,
            };
        }

        if (this.depth >= this.maxDepth) {
            return {
                runId: uuidv4(),
                parentRunId: this.options.parentRunId,
                status: "failed",
                agentId: request.agentId || "unknown-agent",
                agentName: request.agentId || "unknown-agent",
                task,
                createdAt: Date.now(),
                finishedAt: Date.now(),
                error: `Sub-agent depth limit reached (${this.maxDepth}).`,
            };
        }

        const availableAgents = this.options.availableAgents;
        const target = chooseTargetAgent(request, availableAgents, this.options.currentAgentId);
        if (!target) {
            return {
                runId: uuidv4(),
                parentRunId: this.options.parentRunId,
                status: "failed",
                agentId: request.agentId || "unknown-agent",
                agentName: request.agentId || "unknown-agent",
                task,
                createdAt: Date.now(),
                finishedAt: Date.now(),
                error: "No available sub-agent matched the request.",
            };
        }

        if (target.id && target.id === this.options.currentAgentId) {
            return {
                runId: uuidv4(),
                parentRunId: this.options.parentRunId,
                status: "failed",
                agentId: target.id,
                agentName: target.name,
                task,
                createdAt: Date.now(),
                finishedAt: Date.now(),
                error: "Spawning the current agent as its own sub-agent is blocked by runtime policy.",
            };
        }

        const timeoutMs = clampTimeoutMs(request.timeoutMs);
        const shouldAwait = request.awaitCompletion !== false;

        try {
            return await subAgentCoordinator.enqueue({
                parentRunId: this.options.parentRunId,
                agentId: target.id || target.name,
                agentName: target.name,
                task,
                awaitCompletion: shouldAwait,
                timeoutMs,
                execute: async (childRunId) => {
                    const baseConfig = cloneAgentConfig(target);
                    const childConfig: AgentConfig = {
                        ...baseConfig,
                        provider: request.provider || baseConfig.provider,
                        model: request.model || baseConfig.model,
                    };

                    const childAgent = new Agent(childConfig);
                    const childWorkspace = await ensureAgentWorkspace(childConfig);
                    const nestedRuntime = new SubAgentRuntime({
                        availableAgents: this.options.availableAgents,
                        availableTools: this.options.availableTools,
                        apiKeys: this.options.apiKeys,
                        currentAgentId: childConfig.id,
                        currentAgentName: childConfig.name,
                        parentRunId: childRunId,
                        parentExecutionContext: {
                            ...this.options.parentExecutionContext,
                            squadId: this.options.parentExecutionContext?.squadId,
                            squadName: this.options.parentExecutionContext?.squadName,
                            agentWorkspaceRoot: childWorkspace.rootAbsolutePath,
                            agentWorkspaceRootRelative: childWorkspace.rootRelativePath,
                            agentWorkspaceArtifactsDir: childWorkspace.artifactsAbsolutePath,
                            agentWorkspaceArtifactsDirRelative: childWorkspace.artifactsRelativePath,
                        },
                        depth: this.depth + 1,
                        maxDepth: this.maxDepth,
                    });

                    const history = [{
                        id: uuidv4(),
                        role: "user" as const,
                        content: buildSubAgentTaskPrompt(this.options.currentAgentName || "parent-agent", task),
                        timestamp: Date.now(),
                    }];

                    const response = await childAgent.process(
                        history,
                        this.options.apiKeys,
                        this.options.availableTools,
                        {
                            ...(this.options.parentExecutionContext || {}),
                            runId: childRunId,
                            agentWorkspaceRoot: childWorkspace.rootAbsolutePath,
                            agentWorkspaceRootRelative: childWorkspace.rootRelativePath,
                            agentWorkspaceArtifactsDir: childWorkspace.artifactsAbsolutePath,
                            agentWorkspaceArtifactsDirRelative: childWorkspace.artifactsRelativePath,
                            ...nestedRuntime.createExecutionContext(),
                        },
                    );

                    return response.content;
                },
            });
        } catch (error: unknown) {
            return {
                runId: uuidv4(),
                parentRunId: this.options.parentRunId,
                status: "failed",
                agentId: target.id || target.name,
                agentName: target.name,
                task,
                createdAt: Date.now(),
                finishedAt: Date.now(),
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
}
