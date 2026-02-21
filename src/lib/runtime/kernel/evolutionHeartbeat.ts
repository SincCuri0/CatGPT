import { NextRequest, NextResponse } from "next/server";
import type { AgentApiKeys, AgentConfig } from "@/lib/core/Agent";
import { normalizeToolIds } from "@/lib/core/tooling/toolIds";
import { runEvolutionTurn } from "@/lib/evolution/engine";
import { evolutionAgentRunCoordinator } from "@/lib/evolution/agentRunCoordinator";
import { normalizeEvolutionConfig, type NormalizedAgentEvolutionConfig } from "@/lib/evolution/types";
import { initializeEvolutionSchedule, readEvolutionProfile, writeEvolutionProfile } from "@/lib/evolution/store";
import { debugRouteError, debugRouteLog } from "@/lib/debug/server";
import { resolveApiKeys } from "@/lib/api/resolveApiKeys";
import { getErrorMessage, isAgentConfigLike, isRecord, toPreview } from "@/lib/runtime/kernel/validation";
import { loadRuntimeTools } from "@/lib/runtime/kernel/tooling";
import { runtimeTaskSchedulerService, type RuntimeTask } from "@/lib/runtime/services/taskSchedulerService";
import { runtimeStateSyncService } from "@/lib/runtime/services/stateSyncService";
import { buildSecretValuesFromRecord, createSecretsRedactor } from "@/lib/runtime/services/secretsService";

interface HeartbeatRunResult {
    agentId: string;
    agentName: string;
    ok: boolean;
    skipped?: boolean;
    skipReason?: string;
    runId?: string;
    responsePreview?: string;
    error?: string;
}

interface ScheduledHeartbeatPayload {
    agentConfig: AgentConfig;
    agents: AgentConfig[];
    prompt: string;
    toolAccessGranted: boolean;
}

function agentChannel(agent: AgentConfig): string {
    const id = typeof agent.id === "string" && agent.id.trim().length > 0
        ? agent.id.trim().toLowerCase()
        : (agent.name || "unknown-agent").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    return `agent:${id}`;
}

function publishAgentState(agent: AgentConfig, type: string, payload: Record<string, unknown>, status = "active"): void {
    runtimeStateSyncService.publish(agentChannel(agent), type, {
        agentId: agent.id || null,
        agentName: agent.name || null,
        ...payload,
    }, status);
}

function toHeartbeatTaskKey(agent: AgentConfig): string {
    const identity = (agent.id || agent.name || "unknown-agent").trim().toLowerCase();
    return `evolution:heartbeat:${identity}`;
}

function toScheduledPayload(task: RuntimeTask): ScheduledHeartbeatPayload | null {
    const payload = task.payload;
    if (!isRecord(payload) || !isAgentConfigLike(payload.agentConfig)) return null;
    const agents = Array.isArray(payload.agents)
        ? payload.agents.filter((candidate): candidate is AgentConfig => isAgentConfigLike(candidate))
        : [];
    const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
    if (!prompt) return null;
    return {
        agentConfig: payload.agentConfig,
        agents,
        prompt,
        toolAccessGranted: payload.toolAccessGranted === true,
    };
}

async function advanceScheduleOnFailure(
    agent: AgentConfig,
    evolution: NormalizedAgentEvolutionConfig,
    now: number,
): Promise<void> {
    const profile = await readEvolutionProfile(agent);
    await writeEvolutionProfile(agent, {
        ...profile,
        updatedAt: now,
        nextScheduledRunAt: now + evolution.schedule.everyMinutes * 60_000,
    });
}

export async function executeEvolutionHeartbeatPost(req: NextRequest, debugEnabled: boolean): Promise<Response> {
    try {
        debugRouteLog(debugEnabled, "api/evolution/heartbeat", "POST request started");
        const body = await req.json();
        if (!isRecord(body) || !Array.isArray(body.agents)) {
            return NextResponse.json({ error: "Invalid Request: missing agents[]" }, { status: 400 });
        }

        const agents = body.agents.filter((candidate): candidate is AgentConfig => isAgentConfigLike(candidate));
        const forceAgentId = typeof body.forceAgentId === "string" ? body.forceAgentId.trim() : "";
        const forceAgentIds = new Set(forceAgentId ? [forceAgentId] : []);
        const toolAccessGranted = body.toolAccessGranted === true;
        const now = Date.now();
        let checked = 0;
        let due = 0;

        for (const agent of agents) {
            const evolution = normalizeEvolutionConfig(agent.evolution);
            if (!evolution.enabled || !evolution.schedule.enabled) continue;
            checked += 1;

            const seeded = await initializeEvolutionSchedule(agent, evolution.schedule.everyMinutes);
            const isForced = Boolean(agent.id && forceAgentIds.has(agent.id));
            const nextRunAt = typeof seeded.nextScheduledRunAt === "number" ? seeded.nextScheduledRunAt : 0;
            const isDue = isForced || nextRunAt <= now;
            if (!isDue) continue;
            due += 1;

            await runtimeTaskSchedulerService.enqueue({
                key: toHeartbeatTaskKey(agent),
                kind: "cron",
                scheduledAt: now,
                context: {
                    taskType: "evolution_heartbeat",
                    agentId: agent.id || "",
                },
                payload: {
                    agentConfig: agent,
                    agents,
                    prompt: evolution.schedule.prompt,
                    toolAccessGranted,
                },
                maxAttempts: 3,
            });
        }

        await runtimeTaskSchedulerService.repairStaleRunningTasks();
        const acquired = await runtimeTaskSchedulerService.acquireDueTasks({ limit: 60, now });
        const apiKeys = await resolveApiKeys(req);
        const redactor = createSecretsRedactor(buildSecretValuesFromRecord(apiKeys));
        const toolLoad = await loadRuntimeTools(debugEnabled, "api/evolution/heartbeat");
        const tools = toolLoad.tools;
        const mcpTools = toolLoad.mcpTools;
        const runs: HeartbeatRunResult[] = [];

        for (const acquiredTask of acquired) {
            const { task, lease } = acquiredTask;
            const payload = toScheduledPayload(task);
            if (!payload) {
                await runtimeTaskSchedulerService.fail(lease, "Invalid heartbeat task payload.");
                continue;
            }

            const agent = payload.agentConfig;
            const evolution = normalizeEvolutionConfig(agent.evolution);
            if (!(task.context.taskType === "evolution_heartbeat")) {
                await runtimeTaskSchedulerService.complete(lease, { skipped: true, reason: "Task type mismatch." });
                continue;
            }

            const runLease = evolutionAgentRunCoordinator.tryAcquire(agent, "heartbeat");
            if (!runLease) {
                const activeRunTypes = evolutionAgentRunCoordinator.getActiveRunTypes(agent);
                const skipReason = activeRunTypes.includes("user")
                    ? "Skipped: agent is handling an active user conversation."
                    : "Skipped: another run is already active for this agent.";
                runs.push({
                    agentId: agent.id || "unknown-agent",
                    agentName: agent.name || "unknown-agent",
                    ok: true,
                    skipped: true,
                    skipReason,
                });
                await runtimeTaskSchedulerService.complete(lease, { skipped: true, skipReason });
                continue;
            }

            try {
                publishAgentState(agent, "heartbeat_run_started", { taskId: task.id }, "running");
                const requiresMcpAll = normalizeToolIds(agent.tools).includes("mcp_all");
                if (requiresMcpAll && mcpTools.length === 0) {
                    const error = "Scheduled run requires MCP tools (`mcp_all`), but no MCP tools are available.";
                    runs.push({
                        agentId: agent.id || "unknown-agent",
                        agentName: agent.name || "unknown-agent",
                        ok: false,
                        error,
                    });
                    await advanceScheduleOnFailure(agent, evolution, now);
                    await runtimeTaskSchedulerService.complete(lease, { ok: false, error });
                    publishAgentState(agent, "heartbeat_run_failed", { error }, "failed");
                    continue;
                }

                const run = await runEvolutionTurn({
                    agentConfig: agent,
                    agents: payload.agents,
                    tools,
                    apiKeys: apiKeys as AgentApiKeys,
                    prompt: payload.prompt,
                    runType: "autonomy",
                    toolAccessGranted: payload.toolAccessGranted,
                });
                const responsePreview = toPreview(run.response, 220);
                runs.push({
                    agentId: agent.id || "unknown-agent",
                    agentName: agent.name || "unknown-agent",
                    ok: true,
                    runId: run.runId,
                    responsePreview: redactor.maskText(responsePreview),
                });
                await runtimeTaskSchedulerService.complete(lease, {
                    ok: true,
                    runId: run.runId,
                    responsePreview,
                });
                publishAgentState(agent, "heartbeat_run_completed", {
                    runId: run.runId,
                    responseLength: run.response.length,
                }, "completed");
            } catch (error: unknown) {
                const message = redactor.maskText(getErrorMessage(error));
                runs.push({
                    agentId: agent.id || "unknown-agent",
                    agentName: agent.name || "unknown-agent",
                    ok: false,
                    error: message,
                });
                await advanceScheduleOnFailure(agent, evolution, now);
                await runtimeTaskSchedulerService.fail(lease, message);
                publishAgentState(agent, "heartbeat_run_failed", { error: message }, "failed");
            } finally {
                runLease.release();
            }
        }

        debugRouteLog(debugEnabled, "api/evolution/heartbeat", "Heartbeat completed", {
            checked,
            due,
            executed: runs.length,
            skippedRuns: runs.filter((item) => item.skipped).length,
            okRuns: runs.filter((item) => item.ok).length,
            failedRuns: runs.filter((item) => !item.ok).length,
            acquiredTasks: acquired.length,
        });

        return NextResponse.json({
            checkedAgents: checked,
            dueAgents: due,
            runs,
            timestamp: now,
        });
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/evolution/heartbeat", "Unhandled error in POST", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 },
        );
    }
}
