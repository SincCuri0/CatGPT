import fs from "fs/promises";
import path from "path";

interface AgentLike {
    id?: string | null | undefined;
    name?: string | null | undefined;
}

const AGENT_WORKSPACE_ROOT = path.join(process.cwd(), "data", "evolution", "agents");
const AGENT_ARTIFACTS_SUBDIR = "workspace";

function sanitizeSegment(value: string): string {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
    return normalized.slice(0, 80);
}

function toDisplayPath(value: string): string {
    return value.replace(/\\/g, "/");
}

function toWorkspaceRelativePath(absolutePath: string): string {
    const relative = path.relative(process.cwd(), absolutePath);
    return toDisplayPath(relative || ".");
}

export function getAgentWorkspaceKey(agent: AgentLike): string {
    const idCandidate = sanitizeSegment(String(agent.id || ""));
    if (idCandidate) return idCandidate;
    const nameCandidate = sanitizeSegment(String(agent.name || ""));
    if (nameCandidate) return nameCandidate;
    return "agent";
}

export interface AgentWorkspacePaths {
    key: string;
    rootAbsolutePath: string;
    rootRelativePath: string;
    artifactsAbsolutePath: string;
    artifactsRelativePath: string;
}

export function resolveAgentWorkspacePaths(agent: AgentLike): AgentWorkspacePaths {
    const key = getAgentWorkspaceKey(agent);
    const rootAbsolutePath = path.join(AGENT_WORKSPACE_ROOT, key);
    const artifactsAbsolutePath = path.join(rootAbsolutePath, AGENT_ARTIFACTS_SUBDIR);

    return {
        key,
        rootAbsolutePath,
        rootRelativePath: toWorkspaceRelativePath(rootAbsolutePath),
        artifactsAbsolutePath,
        artifactsRelativePath: toWorkspaceRelativePath(artifactsAbsolutePath),
    };
}

export async function ensureAgentWorkspace(agent: AgentLike): Promise<AgentWorkspacePaths> {
    const resolved = resolveAgentWorkspacePaths(agent);
    await fs.mkdir(resolved.rootAbsolutePath, { recursive: true });
    await fs.mkdir(resolved.artifactsAbsolutePath, { recursive: true });
    return resolved;
}
