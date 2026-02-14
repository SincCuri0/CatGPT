import fs from "fs/promises";
import path from "path";
import { SubAgentRunState } from "../types";
import { SubAgentRuntimeConfig } from "./config";

const STORE_VERSION = 1;

interface PersistedRunStatePayload {
    version: number;
    runs: SubAgentRunState[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeRun(value: unknown): SubAgentRunState | null {
    if (!isRecord(value)) return null;
    if (typeof value.runId !== "string" || !value.runId.trim()) return null;
    if (typeof value.agentId !== "string") return null;
    if (typeof value.agentName !== "string") return null;
    if (typeof value.task !== "string") return null;
    if (typeof value.createdAt !== "number") return null;

    const status = typeof value.status === "string" ? value.status : "failed";
    if (!["queued", "running", "completed", "failed", "cancelled"].includes(status)) return null;

    return {
        runId: value.runId,
        parentRunId: typeof value.parentRunId === "string" ? value.parentRunId : undefined,
        status: status as SubAgentRunState["status"],
        agentId: value.agentId,
        agentName: value.agentName,
        task: value.task,
        createdAt: value.createdAt,
        startedAt: typeof value.startedAt === "number" ? value.startedAt : undefined,
        finishedAt: typeof value.finishedAt === "number" ? value.finishedAt : undefined,
        output: typeof value.output === "string" ? value.output : undefined,
        error: typeof value.error === "string" ? value.error : undefined,
    };
}

function sanitizePayload(raw: unknown): PersistedRunStatePayload {
    if (!isRecord(raw)) {
        return { version: STORE_VERSION, runs: [] };
    }

    const version = typeof raw.version === "number" ? raw.version : STORE_VERSION;
    const runs = Array.isArray(raw.runs)
        ? raw.runs.map((run) => sanitizeRun(run)).filter((run): run is SubAgentRunState => Boolean(run))
        : [];

    return {
        version,
        runs,
    };
}

export interface SubAgentRunStore {
    readRuns(): Promise<SubAgentRunState[]>;
    writeRuns(runs: SubAgentRunState[]): Promise<void>;
}

export class InMemorySubAgentRunStore implements SubAgentRunStore {
    private runs: SubAgentRunState[] = [];

    async readRuns(): Promise<SubAgentRunState[]> {
        return this.runs.map((run) => ({ ...run }));
    }

    async writeRuns(runs: SubAgentRunState[]): Promise<void> {
        this.runs = runs.map((run) => ({ ...run }));
    }
}

export class FileSubAgentRunStore implements SubAgentRunStore {
    constructor(private readonly filePath: string) {}

    private async ensureDirectory(): Promise<void> {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    }

    async readRuns(): Promise<SubAgentRunState[]> {
        try {
            const raw = await fs.readFile(this.filePath, "utf-8");
            const parsed = sanitizePayload(JSON.parse(raw));
            return parsed.runs;
        } catch (error: unknown) {
            const nodeError = error as NodeJS.ErrnoException;
            if (nodeError?.code === "ENOENT") {
                return [];
            }
            console.error("Failed to read sub-agent run store; returning empty state", error);
            return [];
        }
    }

    async writeRuns(runs: SubAgentRunState[]): Promise<void> {
        await this.ensureDirectory();
        const payload: PersistedRunStatePayload = {
            version: STORE_VERSION,
            runs,
        };
        const tmpPath = `${this.filePath}.tmp`;
        await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
        await fs.rename(tmpPath, this.filePath);
    }
}

export function createSubAgentRunStore(config: SubAgentRuntimeConfig): SubAgentRunStore {
    if (config.storeMode === "memory") {
        return new InMemorySubAgentRunStore();
    }
    return new FileSubAgentRunStore(config.storePath);
}
