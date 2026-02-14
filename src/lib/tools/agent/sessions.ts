import { SubAgentRunState, SubAgentSpawnRequest, Tool, ToolResult } from "../../core/types";

function asString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function asBoolean(value: unknown, defaultValue: boolean): boolean {
    return typeof value === "boolean" ? value : defaultValue;
}

function asPositiveInteger(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
        return value;
    }
    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return undefined;
}

function errorResult(message: string): ToolResult {
    return {
        ok: false,
        error: message,
        output: message,
        artifacts: [],
        checks: [{ id: "runtime_available", ok: false, description: message }],
    };
}

function summarizeRun(run: SubAgentRunState): string {
    const lines = [
        `runId: ${run.runId}`,
        `status: ${run.status}`,
        `agent: ${run.agentName} (${run.agentId})`,
    ];

    if (run.output) {
        lines.push(`output:\n${run.output}`);
    }
    if (run.error) {
        lines.push(`error: ${run.error}`);
    }

    return lines.join("\n");
}

export const SessionsSpawnTool: Tool = {
    id: "sessions_spawn",
    name: "sessions_spawn",
    description: "Spawn a sub-agent task. Supports synchronous wait or background execution.",
    inputSchema: {
        type: "object",
        properties: {
            task: {
                type: "string",
                description: "Task for the spawned sub-agent.",
            },
            agentId: {
                type: "string",
                description: "Optional explicit target agent ID.",
            },
            provider: {
                type: "string",
                description: "Optional provider override for the sub-agent.",
            },
            model: {
                type: "string",
                description: "Optional model override for the sub-agent.",
            },
            awaitCompletion: {
                type: "boolean",
                description: "If false, return immediately with queued/run metadata.",
            },
            timeoutMs: {
                type: "integer",
                description: "Optional wait timeout when awaitCompletion=true.",
            },
        },
        required: ["task"],
        additionalProperties: false,
    },
    execute: async (args: unknown, context) => {
        if (!context?.spawnSubAgent) {
            return errorResult("Sub-agent runtime is unavailable in this execution context.");
        }

        const task = asString((args as { task?: unknown })?.task).trim();
        if (!task) {
            return errorResult("sessions_spawn requires a non-empty 'task'.");
        }

        const request: SubAgentSpawnRequest = {
            task,
            agentId: asString((args as { agentId?: unknown })?.agentId).trim() || undefined,
            provider: asString((args as { provider?: unknown })?.provider).trim() || undefined,
            model: asString((args as { model?: unknown })?.model).trim() || undefined,
            awaitCompletion: asBoolean((args as { awaitCompletion?: unknown })?.awaitCompletion, true),
            timeoutMs: asPositiveInteger((args as { timeoutMs?: unknown })?.timeoutMs),
        };

        const run = await context.spawnSubAgent(request);
        const ok = run.status !== "failed";

        return {
            ok,
            output: summarizeRun(run),
            error: ok ? undefined : run.error || "Sub-agent run failed.",
            artifacts: [{
                kind: "other",
                label: "subagent-run",
                operation: "spawn",
                metadata: {
                    runId: run.runId,
                    status: run.status,
                    agentId: run.agentId,
                    agentName: run.agentName,
                    parentRunId: run.parentRunId,
                },
            }],
            checks: [{
                id: "subagent_spawned",
                ok,
                description: ok ? "Sub-agent task accepted by runtime." : "Sub-agent task failed.",
                details: run.error,
            }],
        };
    },
};

export const SessionsAwaitTool: Tool = {
    id: "sessions_await",
    name: "sessions_await",
    description: "Wait for a previously spawned sub-agent run to complete.",
    inputSchema: {
        type: "object",
        properties: {
            runId: {
                type: "string",
                description: "Sub-agent run ID returned by sessions_spawn.",
            },
            timeoutMs: {
                type: "integer",
                description: "Optional wait timeout in milliseconds.",
            },
        },
        required: ["runId"],
        additionalProperties: false,
    },
    execute: async (args: unknown, context) => {
        if (!context?.awaitSubAgentRun) {
            return errorResult("Sub-agent await runtime is unavailable in this execution context.");
        }

        const runId = asString((args as { runId?: unknown })?.runId).trim();
        if (!runId) {
            return errorResult("sessions_await requires a non-empty 'runId'.");
        }

        const timeoutMs = asPositiveInteger((args as { timeoutMs?: unknown })?.timeoutMs);
        const run = await context.awaitSubAgentRun(runId, timeoutMs);
        if (!run) {
            return errorResult(`No sub-agent run found for runId '${runId}'.`);
        }

        const ok = run.status === "completed";
        return {
            ok,
            output: summarizeRun(run),
            error: ok ? undefined : run.error,
            artifacts: [{
                kind: "other",
                label: "subagent-run",
                operation: "await",
                metadata: {
                    runId: run.runId,
                    status: run.status,
                },
            }],
            checks: [{
                id: "subagent_completed",
                ok,
                description: ok ? "Sub-agent completed." : `Sub-agent status is '${run.status}'.`,
                details: run.error,
            }],
        };
    },
};

export const SessionsListTool: Tool = {
    id: "sessions_list",
    name: "sessions_list",
    description: "List sub-agent runs associated with the current parent run.",
    inputSchema: {
        type: "object",
        properties: {
            limit: {
                type: "integer",
                description: "Optional number of runs to return (default 20).",
            },
        },
        additionalProperties: false,
    },
    execute: async (args: unknown, context) => {
        if (!context?.listSubAgentRuns) {
            return errorResult("Sub-agent list runtime is unavailable in this execution context.");
        }

        const requestedLimit = asPositiveInteger((args as { limit?: unknown })?.limit) || 20;
        const limit = Math.min(requestedLimit, 100);
        const runs = await context.listSubAgentRuns();
        const trimmed = runs.slice(0, limit);

        return {
            ok: true,
            output: JSON.stringify(trimmed, null, 2),
            artifacts: [{
                kind: "other",
                label: "subagent-run-list",
                operation: "list",
                metadata: {
                    count: trimmed.length,
                },
            }],
            checks: [{
                id: "runs_listed",
                ok: true,
                description: `Returned ${trimmed.length} sub-agent run(s).`,
            }],
        };
    },
};

export const SessionsCancelTool: Tool = {
    id: "sessions_cancel",
    name: "sessions_cancel",
    description: "Cancel a queued or running sub-agent run by runId.",
    inputSchema: {
        type: "object",
        properties: {
            runId: {
                type: "string",
                description: "Sub-agent run ID to cancel.",
            },
            reason: {
                type: "string",
                description: "Optional cancellation reason.",
            },
        },
        required: ["runId"],
        additionalProperties: false,
    },
    execute: async (args: unknown, context) => {
        if (!context?.cancelSubAgentRun) {
            return errorResult("Sub-agent cancel runtime is unavailable in this execution context.");
        }

        const runId = asString((args as { runId?: unknown })?.runId).trim();
        if (!runId) {
            return errorResult("sessions_cancel requires a non-empty 'runId'.");
        }
        const reason = asString((args as { reason?: unknown })?.reason).trim();

        const run = await context.cancelSubAgentRun(runId, reason || undefined);
        if (!run) {
            return errorResult(`No cancellable sub-agent run found for runId '${runId}'.`);
        }

        const ok = run.status === "cancelled";
        return {
            ok,
            output: summarizeRun(run),
            error: ok ? undefined : run.error,
            artifacts: [{
                kind: "other",
                label: "subagent-run",
                operation: "cancel",
                metadata: {
                    runId: run.runId,
                    status: run.status,
                },
            }],
            checks: [{
                id: "subagent_cancelled",
                ok,
                description: ok ? "Sub-agent run cancelled." : `Sub-agent status is '${run.status}'.`,
                details: run.error,
            }],
        };
    },
};
