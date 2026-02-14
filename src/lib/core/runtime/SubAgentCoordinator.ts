import { v4 as uuidv4 } from "uuid";
import { SubAgentRunState } from "../types";
import { subAgentRuntimeConfig, SubAgentRuntimeConfig } from "./config";
import { createSubAgentRunStore, SubAgentRunStore } from "./SubAgentRunStore";

interface EnqueueRunOptions {
    parentRunId?: string;
    agentId: string;
    agentName: string;
    task: string;
    awaitCompletion: boolean;
    timeoutMs: number;
    execute: (runId: string) => Promise<string>;
}

interface QueuedRun {
    runId: string;
    execute: (runId: string) => Promise<string>;
}

function cloneRun(run: SubAgentRunState): SubAgentRunState {
    return {
        ...run,
    };
}

function truncateRunOutput(output: string, maxChars: number): string {
    if (output.length <= maxChars) return output;
    return `${output.slice(0, maxChars)}\n\n[truncated: output exceeded ${maxChars} chars]`;
}

export class SubAgentCoordinator {
    private readonly runs = new Map<string, SubAgentRunState>();
    private readonly queue: QueuedRun[] = [];
    private readonly waiters = new Map<string, Array<(run: SubAgentRunState | null) => void>>();
    private activeRunCount = 0;
    private ready: Promise<void>;
    private writeChain: Promise<void> = Promise.resolve();

    constructor(
        private readonly config: SubAgentRuntimeConfig = subAgentRuntimeConfig,
        private readonly store: SubAgentRunStore = createSubAgentRunStore(config),
    ) {
        this.ready = this.bootstrap();
    }

    private async bootstrap(): Promise<void> {
        const persistedRuns = await this.store.readRuns();
        const now = Date.now();

        for (const run of persistedRuns) {
            if (run.status === "queued" || run.status === "running") {
                run.status = "failed";
                run.error = "Sub-agent run was interrupted by process restart.";
                run.finishedAt = now;
            }
            this.runs.set(run.runId, run);
        }

        const removed = this.cleanupExpiredRunsInternal(now);
        if (removed > 0 || persistedRuns.length > 0) {
            await this.persistRuns();
        }
    }

    public async enqueue(options: EnqueueRunOptions): Promise<SubAgentRunState> {
        await this.ready;
        this.cleanupExpiredRunsInternal();

        if (options.parentRunId) {
            const activeForParent = Array.from(this.runs.values()).filter((run) => (
                run.parentRunId === options.parentRunId
                && (run.status === "queued" || run.status === "running")
            )).length;
            if (activeForParent >= this.config.maxActiveRunsPerParent) {
                throw new Error(
                    `Sub-agent active run limit reached for parent (${this.config.maxActiveRunsPerParent}).`,
                );
            }
        }

        const runId = uuidv4();
        const run: SubAgentRunState = {
            runId,
            parentRunId: options.parentRunId,
            status: "queued",
            agentId: options.agentId,
            agentName: options.agentName,
            task: options.task,
            createdAt: Date.now(),
        };

        this.runs.set(runId, run);
        this.queue.push({
            runId,
            execute: options.execute,
        });

        await this.persistRuns();
        this.pumpQueue();

        if (!options.awaitCompletion) {
            return cloneRun(run);
        }

        const completed = await this.awaitRun(runId, options.timeoutMs);
        if (completed) return completed;

        const fallback = this.runs.get(runId) || run;
        return cloneRun(fallback);
    }

    public async getRun(runId: string): Promise<SubAgentRunState | null> {
        await this.ready;
        const run = this.runs.get(runId);
        return run ? cloneRun(run) : null;
    }

    public async listRuns(parentRunId?: string, limit?: number): Promise<SubAgentRunState[]> {
        await this.ready;
        const removed = this.cleanupExpiredRunsInternal();
        if (removed > 0) {
            await this.persistRuns();
        }

        const safeLimit = Math.min(
            Math.max(1, limit || this.config.maxListedRuns),
            this.config.maxListedRuns,
        );

        const allRuns = Array.from(this.runs.values());
        const filtered = parentRunId
            ? allRuns.filter((run) => run.parentRunId === parentRunId)
            : allRuns;

        return filtered
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, safeLimit)
            .map((run) => cloneRun(run));
    }

    public async awaitRun(runId: string, timeoutMs: number): Promise<SubAgentRunState | null> {
        await this.ready;

        const existing = this.runs.get(runId);
        if (!existing) return null;
        if (existing.status === "completed" || existing.status === "failed" || existing.status === "cancelled") {
            return cloneRun(existing);
        }

        return new Promise<SubAgentRunState | null>((resolve) => {
            const resolver = (run: SubAgentRunState | null) => {
                clearTimeout(timer);
                resolve(run ? cloneRun(run) : null);
            };

            const timer = setTimeout(() => {
                this.removeWaiter(runId, resolver);
                const stillOpen = this.runs.get(runId);
                resolve(stillOpen ? cloneRun(stillOpen) : null);
            }, timeoutMs);

            const existingWaiters = this.waiters.get(runId) || [];
            existingWaiters.push(resolver);
            this.waiters.set(runId, existingWaiters);
        });
    }

    public async getMetrics(): Promise<{
        storedRuns: number;
        queuedRuns: number;
        runningRuns: number;
        cancelledRuns: number;
        activeWorkers: number;
    }> {
        await this.ready;
        let queuedRuns = 0;
        let runningRuns = 0;
        let cancelledRuns = 0;
        for (const run of this.runs.values()) {
            if (run.status === "queued") queuedRuns += 1;
            if (run.status === "running") runningRuns += 1;
            if (run.status === "cancelled") cancelledRuns += 1;
        }

        return {
            storedRuns: this.runs.size,
            queuedRuns,
            runningRuns,
            cancelledRuns,
            activeWorkers: this.activeRunCount,
        };
    }

    public async cancelRun(runId: string, reason: string = "Sub-agent run cancelled."): Promise<SubAgentRunState | null> {
        await this.ready;

        const run = this.runs.get(runId);
        if (!run) return null;
        if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
            return cloneRun(run);
        }

        run.status = "cancelled";
        run.error = reason;
        run.finishedAt = Date.now();
        this.queue.splice(0, this.queue.length, ...this.queue.filter((job) => job.runId !== runId));

        this.cleanupExpiredRunsInternal();
        await this.persistRuns();
        this.notifyRunCompletion(run);
        return cloneRun(run);
    }

    private removeWaiter(runId: string, waiter: (run: SubAgentRunState | null) => void): void {
        const waiters = this.waiters.get(runId);
        if (!waiters || waiters.length === 0) return;
        const nextWaiters = waiters.filter((existing) => existing !== waiter);
        if (nextWaiters.length > 0) {
            this.waiters.set(runId, nextWaiters);
        } else {
            this.waiters.delete(runId);
        }
    }

    private cleanupExpiredRunsInternal(now: number = Date.now()): number {
        const retention = this.config.finishedRunRetentionMs;
        if (retention <= 0) return 0;

        let removed = 0;
        for (const [runId, run] of this.runs.entries()) {
            if (!run.finishedAt) continue;
            if ((now - run.finishedAt) <= retention) continue;

            this.runs.delete(runId);
            this.waiters.delete(runId);
            removed += 1;
        }
        return removed;
    }

    private async persistRuns(): Promise<void> {
        const snapshot = Array.from(this.runs.values())
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((run) => cloneRun(run));

        this.writeChain = this.writeChain
            .then(async () => {
                await this.store.writeRuns(snapshot);
            })
            .catch((error) => {
                console.error("Failed to persist sub-agent runs", error);
            });

        await this.writeChain;
    }

    private pumpQueue(): void {
        while (this.activeRunCount < this.config.maxConcurrency && this.queue.length > 0) {
            const next = this.queue.shift();
            if (!next) return;

            this.activeRunCount += 1;
            void this.executeRun(next)
                .catch((error) => {
                    console.error("Sub-agent run failed:", error);
                })
                .finally(() => {
                    this.activeRunCount = Math.max(0, this.activeRunCount - 1);
                    this.pumpQueue();
                });
        }
    }

    private async executeRun(job: QueuedRun): Promise<void> {
        const run = this.runs.get(job.runId);
        if (!run) return;
        if (run.status === "cancelled") {
            return;
        }

        run.status = "running";
        run.startedAt = Date.now();
        await this.persistRuns();

        try {
            const output = await job.execute(job.runId);
            const currentRun = this.runs.get(job.runId);
            if (!currentRun) {
                return;
            }

            if (currentRun.status === "cancelled") {
                if (!currentRun.finishedAt) {
                    currentRun.finishedAt = Date.now();
                }
            } else {
                currentRun.status = "completed";
                currentRun.output = truncateRunOutput(output, this.config.maxRunOutputChars);
                currentRun.finishedAt = Date.now();
            }
        } catch (error: unknown) {
            const currentRun = this.runs.get(job.runId);
            if (!currentRun) {
                return;
            }

            if (currentRun.status === "cancelled") {
                if (!currentRun.finishedAt) {
                    currentRun.finishedAt = Date.now();
                }
            } else {
                currentRun.status = "failed";
                currentRun.error = error instanceof Error ? error.message : String(error);
                currentRun.finishedAt = Date.now();
            }
        }

        this.cleanupExpiredRunsInternal();
        await this.persistRuns();
        const finalRun = this.runs.get(job.runId);
        if (finalRun) {
            this.notifyRunCompletion(finalRun);
        }
    }

    private notifyRunCompletion(run: SubAgentRunState): void {
        const waiters = this.waiters.get(run.runId) || [];
        for (const waiter of waiters) {
            waiter(run);
        }
        this.waiters.delete(run.runId);
    }
}

export const subAgentCoordinator = new SubAgentCoordinator();
