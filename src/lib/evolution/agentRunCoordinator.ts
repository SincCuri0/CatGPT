import type { AgentConfig } from "@/lib/core/Agent";
import { getAgentWorkspaceKey } from "@/lib/core/agentWorkspace";

export type EvolutionAgentRunType = "user" | "heartbeat" | "autonomy";

interface ActiveRunEntry {
    runId: string;
    runType: EvolutionAgentRunType;
    startedAt: number;
}

export interface AgentRunLease {
    agentKey: string;
    runId: string;
    runType: EvolutionAgentRunType;
    release: () => void;
}

interface AcquireRunOptions {
    allowActiveRunTypes?: EvolutionAgentRunType[];
}

interface WaitForLeaseOptions extends AcquireRunOptions {
    timeoutMs?: number;
    pollIntervalMs?: number;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function resolveAgentKey(agent: AgentConfig | string): string {
    if (typeof agent === "string") {
        const value = agent.trim();
        return value.length > 0 ? value : "unknown-agent";
    }

    const id = typeof agent.id === "string" ? agent.id.trim() : "";
    if (id.length > 0) return id;
    return getAgentWorkspaceKey(agent);
}

class EvolutionAgentRunCoordinator {
    private readonly activeRunsByAgent = new Map<string, Map<string, ActiveRunEntry>>();

    private nextRunCounter = 1;

    private release(agentKey: string, runId: string): void {
        const activeRuns = this.activeRunsByAgent.get(agentKey);
        if (!activeRuns) return;
        activeRuns.delete(runId);
        if (activeRuns.size === 0) {
            this.activeRunsByAgent.delete(agentKey);
        }
    }

    public tryAcquire(
        agent: AgentConfig | string,
        runType: EvolutionAgentRunType,
        options?: AcquireRunOptions,
    ): AgentRunLease | null {
        const agentKey = resolveAgentKey(agent);
        const allowedTypes = new Set(options?.allowActiveRunTypes || []);
        const existingRuns = this.activeRunsByAgent.get(agentKey);

        if (existingRuns) {
            for (const entry of existingRuns.values()) {
                if (!allowedTypes.has(entry.runType)) {
                    return null;
                }
            }
        }

        const runId = `${runType}-${Date.now()}-${this.nextRunCounter++}`;
        const activeRuns = existingRuns || new Map<string, ActiveRunEntry>();
        activeRuns.set(runId, {
            runId,
            runType,
            startedAt: Date.now(),
        });
        this.activeRunsByAgent.set(agentKey, activeRuns);

        let released = false;
        return {
            agentKey,
            runId,
            runType,
            release: () => {
                if (released) return;
                released = true;
                this.release(agentKey, runId);
            },
        };
    }

    public hasAnyActiveRuns(agent: AgentConfig | string): boolean {
        const agentKey = resolveAgentKey(agent);
        const activeRuns = this.activeRunsByAgent.get(agentKey);
        return Boolean(activeRuns && activeRuns.size > 0);
    }

    public hasActiveRunType(agent: AgentConfig | string, runType: EvolutionAgentRunType): boolean {
        const agentKey = resolveAgentKey(agent);
        const activeRuns = this.activeRunsByAgent.get(agentKey);
        if (!activeRuns) return false;
        for (const entry of activeRuns.values()) {
            if (entry.runType === runType) return true;
        }
        return false;
    }

    public getActiveRunTypes(agent: AgentConfig | string): EvolutionAgentRunType[] {
        const agentKey = resolveAgentKey(agent);
        const activeRuns = this.activeRunsByAgent.get(agentKey);
        if (!activeRuns) return [];
        const types = new Set<EvolutionAgentRunType>();
        for (const entry of activeRuns.values()) {
            types.add(entry.runType);
        }
        return [...types];
    }
}

export const evolutionAgentRunCoordinator = new EvolutionAgentRunCoordinator();

export async function acquireAgentRunLease(
    agent: AgentConfig | string,
    runType: EvolutionAgentRunType,
    options?: WaitForLeaseOptions,
): Promise<AgentRunLease | null> {
    const timeoutMs = Math.max(0, Math.floor(options?.timeoutMs ?? 0));
    const pollIntervalMs = Math.max(25, Math.floor(options?.pollIntervalMs ?? 150));
    const deadline = Date.now() + timeoutMs;

    while (true) {
        const lease = evolutionAgentRunCoordinator.tryAcquire(agent, runType, options);
        if (lease) return lease;
        if (Date.now() >= deadline) return null;
        const waitMs = Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()));
        await sleep(waitMs);
    }
}
