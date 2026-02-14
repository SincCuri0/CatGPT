import path from "path";

function readPositiveIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
}

function readNonNegativeIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
        return fallback;
    }
    return parsed;
}

function readStoreModeEnv(): "file" | "memory" {
    const raw = (process.env.SUBAGENT_STORE_MODE || "file").trim().toLowerCase();
    return raw === "memory" ? "memory" : "file";
}

export interface SubAgentRuntimeConfig {
    maxDepth: number;
    maxConcurrency: number;
    maxActiveRunsPerParent: number;
    defaultTimeoutMs: number;
    maxTimeoutMs: number;
    maxTaskChars: number;
    maxRunOutputChars: number;
    finishedRunRetentionMs: number;
    maxListedRuns: number;
    storeMode: "file" | "memory";
    storePath: string;
}

const defaultStorePath = path.join(process.cwd(), "data", "subagent-runs.json");

export const subAgentRuntimeConfig: SubAgentRuntimeConfig = {
    maxDepth: readPositiveIntEnv("SUBAGENT_MAX_DEPTH", 3),
    maxConcurrency: readPositiveIntEnv("SUBAGENT_MAX_CONCURRENCY", 3),
    maxActiveRunsPerParent: readPositiveIntEnv("SUBAGENT_MAX_ACTIVE_RUNS_PER_PARENT", 12),
    defaultTimeoutMs: readPositiveIntEnv("SUBAGENT_DEFAULT_TIMEOUT_MS", 120_000),
    maxTimeoutMs: readPositiveIntEnv("SUBAGENT_MAX_TIMEOUT_MS", 600_000),
    maxTaskChars: readPositiveIntEnv("SUBAGENT_MAX_TASK_CHARS", 12_000),
    maxRunOutputChars: readPositiveIntEnv("SUBAGENT_MAX_OUTPUT_CHARS", 80_000),
    finishedRunRetentionMs: readNonNegativeIntEnv("SUBAGENT_RUN_RETENTION_MS", 24 * 60 * 60 * 1000),
    maxListedRuns: readPositiveIntEnv("SUBAGENT_MAX_LISTED_RUNS", 100),
    storeMode: readStoreModeEnv(),
    storePath: process.env.SUBAGENT_STORE_PATH?.trim() || defaultStorePath,
};

export function clampTimeoutMs(requested: number | undefined): number {
    const requestedSafe = typeof requested === "number" && Number.isInteger(requested) && requested > 0
        ? requested
        : subAgentRuntimeConfig.defaultTimeoutMs;
    return Math.min(requestedSafe, subAgentRuntimeConfig.maxTimeoutMs);
}
