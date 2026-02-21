import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";

export type RuntimeTaskKind = "adhoc" | "planned" | "cron";
export type RuntimeTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface RuntimeTask {
    id: string;
    key?: string;
    kind: RuntimeTaskKind;
    status: RuntimeTaskStatus;
    createdAt: number;
    updatedAt: number;
    scheduledAt: number;
    startedAt?: number;
    finishedAt?: number;
    attempts: number;
    maxAttempts: number;
    context: Record<string, string>;
    payload: Record<string, unknown>;
    lastError?: string;
    lastResult?: Record<string, unknown>;
}

export interface RuntimeTaskLease {
    taskId: string;
    lockToken: string;
}

interface RuntimeTaskStoreShape {
    version: 1;
    updatedAt: number;
    tasks: RuntimeTask[];
}

export interface EnqueueRuntimeTaskInput {
    key?: string;
    kind: RuntimeTaskKind;
    scheduledAt?: number;
    maxAttempts?: number;
    context?: Record<string, string>;
    payload?: Record<string, unknown>;
}

interface AcquireDueTasksOptions {
    limit?: number;
    now?: number;
}

interface ListTasksOptions {
    status?: RuntimeTaskStatus | RuntimeTaskStatus[];
    kind?: RuntimeTaskKind | RuntimeTaskKind[];
    context?: Record<string, string>;
    limit?: number;
}

const TASK_STORE_RELATIVE_PATH = path.join(".runtime", "scheduler", "tasks.json");
const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_TASKS = 2_000;

function sanitizeLimit(value: number | undefined, fallback: number): number {
    const candidate = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.max(1, Math.min(200, candidate));
}

function sanitizeMaxAttempts(value: number | undefined): number {
    const candidate = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_MAX_ATTEMPTS;
    return Math.max(1, Math.min(8, candidate));
}

function stableKey(value: string): string {
    return value.trim().toLowerCase();
}

function hashTaskId(input: string): string {
    return createHash("sha1").update(input).digest("hex").slice(0, 20);
}

function sanitizeContext(value: Record<string, string> | undefined): Record<string, string> {
    if (!value) return {};
    const output: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
        const safeKey = key.trim();
        const safeValue = typeof entry === "string" ? entry.trim() : "";
        if (!safeKey || !safeValue) continue;
        output[safeKey] = safeValue;
    }
    return output;
}

function sanitizePayload(value: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!value) return {};
    return { ...value };
}

function asArray<T>(value: T | T[] | undefined): T[] {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function isContextMatch(task: RuntimeTask, filter: Record<string, string>): boolean {
    for (const [key, value] of Object.entries(filter)) {
        if (task.context[key] !== value) return false;
    }
    return true;
}

export class RuntimeTaskSchedulerService {
    private readonly storePath: string;
    private tasks = new Map<string, RuntimeTask>();
    private activeLeases = new Map<string, string>();
    private loaded = false;
    private operationQueue: Promise<void> = Promise.resolve();

    constructor(storePath?: string) {
        this.storePath = storePath || path.join(process.cwd(), TASK_STORE_RELATIVE_PATH);
    }

    private async withLock<T>(action: () => Promise<T>): Promise<T> {
        const previous = this.operationQueue;
        let release!: () => void;
        this.operationQueue = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await action();
        } finally {
            release();
        }
    }

    private sanitizeTask(raw: unknown): RuntimeTask | null {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const source = raw as Record<string, unknown>;
        const id = typeof source.id === "string" ? source.id.trim() : "";
        if (!id) return null;
        const kind = source.kind === "adhoc" || source.kind === "planned" || source.kind === "cron"
            ? source.kind
            : "adhoc";
        const status = source.status === "queued"
            || source.status === "running"
            || source.status === "completed"
            || source.status === "failed"
            || source.status === "cancelled"
            ? source.status
            : "queued";
        const createdAt = typeof source.createdAt === "number" && Number.isFinite(source.createdAt)
            ? Math.floor(source.createdAt)
            : Date.now();
        const updatedAt = typeof source.updatedAt === "number" && Number.isFinite(source.updatedAt)
            ? Math.floor(source.updatedAt)
            : createdAt;
        const scheduledAt = typeof source.scheduledAt === "number" && Number.isFinite(source.scheduledAt)
            ? Math.floor(source.scheduledAt)
            : createdAt;
        const attempts = typeof source.attempts === "number" && Number.isFinite(source.attempts)
            ? Math.max(0, Math.floor(source.attempts))
            : 0;
        const maxAttempts = sanitizeMaxAttempts(typeof source.maxAttempts === "number" ? source.maxAttempts : undefined);

        const task: RuntimeTask = {
            id,
            key: typeof source.key === "string" ? source.key.trim() : undefined,
            kind,
            status,
            createdAt,
            updatedAt,
            scheduledAt,
            attempts,
            maxAttempts,
            context: sanitizeContext(source.context as Record<string, string> | undefined),
            payload: sanitizePayload(source.payload as Record<string, unknown> | undefined),
        };
        if (typeof source.startedAt === "number" && Number.isFinite(source.startedAt)) {
            task.startedAt = Math.floor(source.startedAt);
        }
        if (typeof source.finishedAt === "number" && Number.isFinite(source.finishedAt)) {
            task.finishedAt = Math.floor(source.finishedAt);
        }
        if (typeof source.lastError === "string" && source.lastError.trim()) {
            task.lastError = source.lastError.trim();
        }
        if (source.lastResult && typeof source.lastResult === "object" && !Array.isArray(source.lastResult)) {
            task.lastResult = sanitizePayload(source.lastResult as Record<string, unknown>);
        }
        return task;
    }

    private async loadIfNeeded(): Promise<void> {
        if (this.loaded) return;
        this.loaded = true;
        try {
            const raw = await fs.readFile(this.storePath, "utf-8");
            const parsed = JSON.parse(raw) as RuntimeTaskStoreShape;
            const tasksRaw = Array.isArray(parsed.tasks) ? parsed.tasks : [];
            for (const candidate of tasksRaw) {
                const task = this.sanitizeTask(candidate);
                if (!task) continue;
                this.tasks.set(task.id, task);
            }
        } catch {
            // First run or invalid file: start empty.
        }
    }

    private async persist(): Promise<void> {
        const shape: RuntimeTaskStoreShape = {
            version: 1,
            updatedAt: Date.now(),
            tasks: Array.from(this.tasks.values())
                .sort((left, right) => right.updatedAt - left.updatedAt)
                .slice(0, MAX_TASKS),
        };
        await fs.mkdir(path.dirname(this.storePath), { recursive: true });
        await fs.writeFile(this.storePath, `${JSON.stringify(shape, null, 2)}\n`, "utf-8");
    }

    private taskFromInput(input: EnqueueRuntimeTaskInput, now: number): RuntimeTask {
        const scheduledAt = typeof input.scheduledAt === "number" && Number.isFinite(input.scheduledAt)
            ? Math.max(0, Math.floor(input.scheduledAt))
            : now;
        const key = input.key ? stableKey(input.key) : undefined;
        const deterministicPart = key || `${input.kind}:${scheduledAt}:${Math.random().toString(36).slice(2, 9)}`;
        const id = hashTaskId(`${deterministicPart}:${Date.now()}`);

        return {
            id,
            key,
            kind: input.kind,
            status: "queued",
            createdAt: now,
            updatedAt: now,
            scheduledAt,
            attempts: 0,
            maxAttempts: sanitizeMaxAttempts(input.maxAttempts),
            context: sanitizeContext(input.context),
            payload: sanitizePayload(input.payload),
        };
    }

    private findByKey(key: string): RuntimeTask | null {
        const normalized = stableKey(key);
        for (const task of this.tasks.values()) {
            if (task.key === normalized) return task;
        }
        return null;
    }

    async enqueue(input: EnqueueRuntimeTaskInput): Promise<RuntimeTask> {
        return this.withLock(async () => {
            await this.loadIfNeeded();
            const now = Date.now();
            if (input.key) {
                const existing = this.findByKey(input.key);
                if (existing) {
                    existing.kind = input.kind;
                    existing.scheduledAt = typeof input.scheduledAt === "number"
                        ? Math.max(0, Math.floor(input.scheduledAt))
                        : existing.scheduledAt;
                    existing.maxAttempts = sanitizeMaxAttempts(input.maxAttempts ?? existing.maxAttempts);
                    existing.payload = sanitizePayload(input.payload);
                    existing.context = sanitizeContext(input.context);
                    if (existing.status === "completed" || existing.status === "failed" || existing.status === "cancelled") {
                        existing.status = "queued";
                        existing.attempts = 0;
                        existing.startedAt = undefined;
                        existing.finishedAt = undefined;
                        existing.lastError = undefined;
                        existing.lastResult = undefined;
                    }
                    existing.updatedAt = now;
                    await this.persist();
                    return { ...existing };
                }
            }

            const nextTask = this.taskFromInput(input, now);
            this.tasks.set(nextTask.id, nextTask);
            await this.persist();
            return { ...nextTask };
        });
    }

    async cancel(taskId: string, reason?: string): Promise<RuntimeTask | null> {
        return this.withLock(async () => {
            await this.loadIfNeeded();
            const task = this.tasks.get(taskId);
            if (!task) return null;
            if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
                return { ...task };
            }

            task.status = "cancelled";
            task.updatedAt = Date.now();
            task.finishedAt = task.updatedAt;
            if (reason && reason.trim()) task.lastError = reason.trim();
            this.activeLeases.delete(task.id);
            await this.persist();
            return { ...task };
        });
    }

    async list(options?: ListTasksOptions): Promise<RuntimeTask[]> {
        return this.withLock(async () => {
            await this.loadIfNeeded();
            const statusFilter = new Set(asArray(options?.status));
            const kindFilter = new Set(asArray(options?.kind));
            const contextFilter = sanitizeContext(options?.context);
            const limit = sanitizeLimit(options?.limit, 200);

            const items = Array.from(this.tasks.values())
                .filter((task) => statusFilter.size === 0 || statusFilter.has(task.status))
                .filter((task) => kindFilter.size === 0 || kindFilter.has(task.kind))
                .filter((task) => Object.keys(contextFilter).length === 0 || isContextMatch(task, contextFilter))
                .sort((left, right) => right.updatedAt - left.updatedAt)
                .slice(0, limit)
                .map((task) => ({ ...task }));
            return items;
        });
    }

    async repairStaleRunningTasks(maxAgeMs = 10 * 60_000): Promise<number> {
        return this.withLock(async () => {
            await this.loadIfNeeded();
            const now = Date.now();
            let repaired = 0;
            for (const task of this.tasks.values()) {
                if (task.status !== "running") continue;
                const startedAt = task.startedAt || task.updatedAt;
                if ((now - startedAt) < maxAgeMs) continue;
                task.status = task.attempts < task.maxAttempts ? "queued" : "failed";
                task.updatedAt = now;
                task.finishedAt = task.status === "failed" ? now : undefined;
                task.lastError = task.status === "failed"
                    ? "Task marked failed after stale running timeout."
                    : "Task repaired from stale running state.";
                this.activeLeases.delete(task.id);
                repaired += 1;
            }
            if (repaired > 0) {
                await this.persist();
            }
            return repaired;
        });
    }

    async acquireDueTasks(options?: AcquireDueTasksOptions): Promise<Array<{ task: RuntimeTask; lease: RuntimeTaskLease }>> {
        return this.withLock(async () => {
            await this.loadIfNeeded();
            const now = typeof options?.now === "number" && Number.isFinite(options.now)
                ? Math.floor(options.now)
                : Date.now();
            const limit = sanitizeLimit(options?.limit, 20);

            const due = Array.from(this.tasks.values())
                .filter((task) => task.status === "queued")
                .filter((task) => task.scheduledAt <= now)
                .sort((left, right) => left.scheduledAt - right.scheduledAt)
                .slice(0, limit);

            const acquired: Array<{ task: RuntimeTask; lease: RuntimeTaskLease }> = [];
            for (const task of due) {
                if (this.activeLeases.has(task.id)) continue;
                const lockToken = hashTaskId(`${task.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`);
                this.activeLeases.set(task.id, lockToken);
                task.status = "running";
                task.startedAt = now;
                task.updatedAt = now;
                task.attempts += 1;
                acquired.push({
                    task: { ...task },
                    lease: { taskId: task.id, lockToken },
                });
            }
            if (acquired.length > 0) {
                await this.persist();
            }
            return acquired;
        });
    }

    async complete(
        lease: RuntimeTaskLease,
        result?: Record<string, unknown>,
    ): Promise<RuntimeTask | null> {
        return this.withLock(async () => {
            await this.loadIfNeeded();
            const task = this.tasks.get(lease.taskId);
            if (!task) return null;
            const activeToken = this.activeLeases.get(task.id);
            if (!activeToken || activeToken !== lease.lockToken) return null;

            this.activeLeases.delete(task.id);
            task.status = "completed";
            task.updatedAt = Date.now();
            task.finishedAt = task.updatedAt;
            task.lastError = undefined;
            task.lastResult = sanitizePayload(result);
            await this.persist();
            return { ...task };
        });
    }

    async fail(lease: RuntimeTaskLease, error: string): Promise<RuntimeTask | null> {
        return this.withLock(async () => {
            await this.loadIfNeeded();
            const task = this.tasks.get(lease.taskId);
            if (!task) return null;
            const activeToken = this.activeLeases.get(task.id);
            if (!activeToken || activeToken !== lease.lockToken) return null;

            this.activeLeases.delete(task.id);
            task.updatedAt = Date.now();
            task.lastError = error.trim() || "Task execution failed.";
            if (task.attempts >= task.maxAttempts) {
                task.status = "failed";
                task.finishedAt = task.updatedAt;
            } else {
                task.status = "queued";
                task.scheduledAt = Date.now() + 30_000;
            }
            await this.persist();
            return { ...task };
        });
    }
}

const globalState = globalThis as unknown as {
    __catGptRuntimeTaskSchedulerService?: RuntimeTaskSchedulerService;
};

export const runtimeTaskSchedulerService = globalState.__catGptRuntimeTaskSchedulerService
    || new RuntimeTaskSchedulerService();

if (!globalState.__catGptRuntimeTaskSchedulerService) {
    globalState.__catGptRuntimeTaskSchedulerService = runtimeTaskSchedulerService;
}
