import { SubAgentRunState, SubAgentSpawnRequest, Tool, ToolResult } from "../../core/types";

type SubAgentAction = "spawn" | "await" | "list" | "cancel";

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

function spawnResult(run: SubAgentRunState): ToolResult {
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
}

function awaitResult(run: SubAgentRunState): ToolResult {
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
}

function listResult(trimmedRuns: SubAgentRunState[]): ToolResult {
    return {
        ok: true,
        output: JSON.stringify(trimmedRuns, null, 2),
        artifacts: [{
            kind: "other",
            label: "subagent-run-list",
            operation: "list",
            metadata: {
                count: trimmedRuns.length,
            },
        }],
        checks: [{
            id: "runs_listed",
            ok: true,
            description: `Returned ${trimmedRuns.length} sub-agent run(s).`,
        }],
    };
}

function cancelResult(run: SubAgentRunState): ToolResult {
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
}

function normalizeAction(value: unknown): SubAgentAction | null {
    const action = asString(value).trim().toLowerCase();
    if (action === "spawn" || action === "await" || action === "list" || action === "cancel") {
        return action;
    }
    return null;
}

export const SubAgentsTool: Tool = {
    id: "subagents",
    name: "subagents",
    description: "Manage sub-agent delegation runs. Actions: spawn, await, list, cancel.",
    inputSchema: {
        type: "object",
        properties: {
            action: {
                type: "string",
                enum: ["spawn", "await", "list", "cancel"],
                description: "Sub-agent operation to execute.",
            },
            task: {
                type: "string",
                description: "Task for action=spawn. Keep it focused and include only context required to execute.",
            },
            agentId: {
                type: "string",
                description: "Optional explicit target agent ID for action=spawn.",
            },
            provider: {
                type: "string",
                description: "Optional provider override for action=spawn.",
            },
            model: {
                type: "string",
                description: "Optional model override for action=spawn.",
            },
            awaitCompletion: {
                type: "boolean",
                description: "For action=spawn: if false, return immediately with queued/run metadata.",
            },
            runId: {
                type: "string",
                description: "Sub-agent run ID for action=await or action=cancel.",
            },
            timeoutMs: {
                type: "integer",
                description: "Optional timeout for action=spawn (when awaiting) or action=await.",
            },
            limit: {
                type: "integer",
                description: "Optional number of runs to return for action=list (default 20, max 100).",
            },
            reason: {
                type: "string",
                description: "Optional cancellation reason for action=cancel.",
            },
        },
        required: ["action"],
        additionalProperties: false,
    },
    execute: async (args: unknown, context) => {
        const action = normalizeAction((args as { action?: unknown })?.action);
        if (!action) {
            return errorResult("subagents requires a valid 'action' (spawn|await|list|cancel).");
        }

        if (action === "spawn") {
            if (!context?.spawnSubAgent) {
                return errorResult("Sub-agent runtime is unavailable in this execution context.");
            }

            const task = asString((args as { task?: unknown })?.task).trim();
            if (!task) {
                return errorResult("subagents(action=spawn) requires a non-empty 'task'.");
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
            return spawnResult(run);
        }

        if (action === "await") {
            if (!context?.awaitSubAgentRun) {
                return errorResult("Sub-agent await runtime is unavailable in this execution context.");
            }

            const runId = asString((args as { runId?: unknown })?.runId).trim();
            if (!runId) {
                return errorResult("subagents(action=await) requires a non-empty 'runId'.");
            }

            const timeoutMs = asPositiveInteger((args as { timeoutMs?: unknown })?.timeoutMs);
            const run = await context.awaitSubAgentRun(runId, timeoutMs);
            if (!run) {
                return errorResult(`No sub-agent run found for runId '${runId}'.`);
            }

            return awaitResult(run);
        }

        if (action === "list") {
            if (!context?.listSubAgentRuns) {
                return errorResult("Sub-agent list runtime is unavailable in this execution context.");
            }

            const requestedLimit = asPositiveInteger((args as { limit?: unknown })?.limit) || 20;
            const limit = Math.min(requestedLimit, 100);
            const runs = await context.listSubAgentRuns();
            const trimmed = runs.slice(0, limit);
            return listResult(trimmed);
        }

        if (!context?.cancelSubAgentRun) {
            return errorResult("Sub-agent cancel runtime is unavailable in this execution context.");
        }

        const runId = asString((args as { runId?: unknown })?.runId).trim();
        if (!runId) {
            return errorResult("subagents(action=cancel) requires a non-empty 'runId'.");
        }
        const reason = asString((args as { reason?: unknown })?.reason).trim();

        const run = await context.cancelSubAgentRun(runId, reason || undefined);
        if (!run) {
            return errorResult(`No cancellable sub-agent run found for runId '${runId}'.`);
        }

        return cancelResult(run);
    },
};
