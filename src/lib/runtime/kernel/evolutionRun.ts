import { NextRequest, NextResponse } from "next/server";
import type { AgentApiKeys, AgentConfig } from "@/lib/core/Agent";
import { normalizeToolIds } from "@/lib/core/tooling/toolIds";
import { runEvolutionTurn } from "@/lib/evolution/engine";
import { acquireAgentRunLease, type AgentRunLease } from "@/lib/evolution/agentRunCoordinator";
import { normalizeEvolutionConfig } from "@/lib/evolution/types";
import { debugRouteError, debugRouteLog } from "@/lib/debug/server";
import { resolveApiKeys } from "@/lib/api/resolveApiKeys";
import { getErrorMessage, isAgentConfigLike, isRecord } from "@/lib/runtime/kernel/validation";
import { loadRuntimeTools } from "@/lib/runtime/kernel/tooling";
import {
    buildSecretValuesFromRecord,
    createSecretsRedactor,
} from "@/lib/runtime/services/secretsService";
import { runtimeStateSyncService } from "@/lib/runtime/services/stateSyncService";
import { runtimeTaskSchedulerService } from "@/lib/runtime/services/taskSchedulerService";

function runChannel(runId: string): string {
    return `run:${runId.toLowerCase()}`;
}

function agentChannel(agent: AgentConfig): string {
    const id = typeof agent.id === "string" && agent.id.trim().length > 0
        ? agent.id.trim().toLowerCase()
        : (agent.name || "unknown-agent").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    return `agent:${id}`;
}

function publishEvolutionRunState(
    runId: string,
    agent: AgentConfig,
    type: string,
    payload: Record<string, unknown>,
    status = "active",
): void {
    const eventPayload = {
        runId,
        agentId: agent.id || null,
        agentName: agent.name || null,
        ...payload,
    };
    runtimeStateSyncService.publish(runChannel(runId), type, eventPayload, status);
    runtimeStateSyncService.publish(agentChannel(agent), type, eventPayload, status);
}

export async function executeEvolutionRunPost(req: NextRequest, debugEnabled: boolean): Promise<Response> {
    let agentRunLease: AgentRunLease | null = null;
    let schedulerTaskLease: { taskId: string; lockToken: string } | null = null;
    let scheduledAgent: AgentConfig | null = null;
    try {
        debugRouteLog(debugEnabled, "api/evolution/run", "POST request started");
        const body = await req.json();
        if (!isRecord(body) || !isAgentConfigLike(body.agentConfig)) {
            return NextResponse.json({ error: "Invalid Request: missing agentConfig" }, { status: 400 });
        }

        const agentConfig = body.agentConfig;
        scheduledAgent = agentConfig;
        const agents = Array.isArray(body.agents)
            ? body.agents.filter((candidate): candidate is AgentConfig => isAgentConfigLike(candidate))
            : [];
        const inputPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        const toolAccessGranted = body.toolAccessGranted === true;

        const evolution = normalizeEvolutionConfig(agentConfig.evolution);
        if (!evolution.enabled) {
            return NextResponse.json({ error: "Evolution mode is not enabled for this agent." }, { status: 400 });
        }

        const prompt = inputPrompt || evolution.schedule.prompt;
        if (!prompt) {
            return NextResponse.json({ error: "Evolution prompt is required." }, { status: 400 });
        }

        const apiKeys = await resolveApiKeys(req);
        const redactor = createSecretsRedactor(buildSecretValuesFromRecord(apiKeys));
        const toolLoad = await loadRuntimeTools(debugEnabled, "api/evolution/run");
        const tools = toolLoad.tools;
        const mcpTools = toolLoad.mcpTools;
        const mcpLoadError = toolLoad.mcpLoadError;

        const requestedTools = new Set(normalizeToolIds(agentConfig.tools));
        if (requestedTools.has("mcp_all") && (mcpLoadError || mcpTools.length === 0)) {
            return NextResponse.json({
                error: "This evolution run requires MCP tools (`mcp_all`), but MCP services are unavailable.",
                details: mcpLoadError || "No MCP tools were discovered from enabled services.",
            }, { status: 503 });
        }

        agentRunLease = await acquireAgentRunLease(agentConfig, "autonomy", {
            timeoutMs: 2_000,
            pollIntervalMs: 150,
        });
        if (!agentRunLease) {
            return NextResponse.json(
                {
                    error: "Agent is busy with another run. Try again shortly.",
                    details: "A user or scheduled run is currently active for this agent.",
                },
                { status: 409 },
            );
        }

        await runtimeTaskSchedulerService.repairStaleRunningTasks();
        const scheduledTask = await runtimeTaskSchedulerService.enqueue({
            kind: "adhoc",
            scheduledAt: Date.now(),
            context: {
                taskType: "evolution_manual",
                agentId: agentConfig.id || "",
            },
            payload: {
                agentConfig,
                agents,
                prompt,
                toolAccessGranted,
            },
            maxAttempts: 1,
        });
        const acquired = await runtimeTaskSchedulerService.acquireDueTasks({ limit: 40, now: Date.now() });
        const acquiredTask = acquired.find((entry) => entry.task.id === scheduledTask.id);
        if (!acquiredTask) {
            return NextResponse.json({
                error: "Scheduler could not acquire the evolution task.",
            }, { status: 503 });
        }
        schedulerTaskLease = acquiredTask.lease;
        publishEvolutionRunState(scheduledTask.id, agentConfig, "evolution_task_started", {
            promptLength: prompt.length,
            schedulerTaskId: scheduledTask.id,
        }, "running");

        const run = await runEvolutionTurn({
            agentConfig,
            agents,
            tools,
            apiKeys: apiKeys as AgentApiKeys,
            prompt,
            runType: "autonomy",
            toolAccessGranted,
        });
        await runtimeTaskSchedulerService.complete(acquiredTask.lease, {
            runId: run.runId,
            responsePreview: run.response.slice(0, 240),
        });
        schedulerTaskLease = null;
        publishEvolutionRunState(run.runId, agentConfig, "evolution_run_completed", {
            promptLength: prompt.length,
            responseLength: run.response.length,
            schedulerTaskId: scheduledTask.id,
        }, "completed");

        debugRouteLog(debugEnabled, "api/evolution/run", "Evolution run completed", {
            agentId: agentConfig.id,
            runId: run.runId,
            responseLength: run.response.length,
            schedulerTaskId: scheduledTask.id,
        });

        return NextResponse.json({
            response: redactor.maskText(run.response),
            runId: run.runId,
            evolution: run.status,
        });
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/evolution/run", "Unhandled error in POST", error);
        if (schedulerTaskLease) {
            await runtimeTaskSchedulerService.fail(schedulerTaskLease, getErrorMessage(error));
            if (scheduledAgent) {
                publishEvolutionRunState(
                    schedulerTaskLease.taskId,
                    scheduledAgent,
                    "evolution_task_failed",
                    { error: getErrorMessage(error) },
                    "failed",
                );
            }
            schedulerTaskLease = null;
        }
        const message = getErrorMessage(error);
        const redactedMessage = message.replace(/(api[_-]?key|token|secret)[^.,;:]*/gi, "$1 [REDACTED]");
        if (redactedMessage.toLowerCase().includes("api key")) {
            return NextResponse.json({ error: redactedMessage }, { status: 401 });
        }
        return NextResponse.json({
            error: "Internal Server Error",
            details: redactedMessage,
        }, { status: 500 });
    } finally {
        agentRunLease?.release();
    }
}
