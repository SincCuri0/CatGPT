import fs from "fs/promises";
import type { Dirent } from "fs";
import path from "path";
import type { AgentConfig } from "@/lib/core/Agent";
import { normalizeToolIds } from "@/lib/core/tooling/toolIds";
import { resolveAgentWorkspacePaths } from "@/lib/core/agentWorkspace";

const SKILLS_DIR = "skills";
const STOP_WORDS = new Set([
    "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with", "is", "are", "was", "were",
    "be", "been", "being", "as", "at", "by", "that", "this", "it", "from", "we", "you", "i", "they", "he", "she",
    "them", "our", "your", "their", "can", "could", "should", "would", "may", "might", "must", "do", "does", "did",
]);

export interface RuntimeSkill {
    id: string;
    name: string;
    path: string;
    content: string;
    triggers: string[];
    allowedTools: string[];
    score: number;
}

interface ParsedFrontmatter {
    triggers: string[];
    allowedTools: string[];
}

function tokenize(value: string): string[] {
    return value
        .toLowerCase()
        .replace(/[`*_~[\](){}<>#|]/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function parseListLiteral(value: string): string[] {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        return trimmed
            .slice(1, -1)
            .split(",")
            .map((item) => item.trim().replace(/^["']|["']$/g, ""))
            .filter((item) => item.length > 0);
    }
    return [trimmed.replace(/^["']|["']$/g, "")].filter(Boolean);
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
    const lines = raw.split(/\r?\n/);
    if (lines[0]?.trim() !== "---") {
        return { triggers: [], allowedTools: [] };
    }
    const result: ParsedFrontmatter = { triggers: [], allowedTools: [] };
    for (let index = 1; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (line === "---") break;
        const separatorIndex = line.indexOf(":");
        if (separatorIndex <= 0) continue;
        const key = line.slice(0, separatorIndex).trim().toLowerCase();
        const value = line.slice(separatorIndex + 1).trim();
        if (key === "triggers") {
            result.triggers = parseListLiteral(value).map((item) => item.toLowerCase());
        }
        if (key === "allowed_tools" || key === "allowedtools") {
            result.allowedTools = parseListLiteral(value);
        }
    }
    return result;
}

function stripFrontmatter(raw: string): string {
    const lines = raw.split(/\r?\n/);
    if (lines[0]?.trim() !== "---") return raw;
    let endIndex = -1;
    for (let index = 1; index < lines.length; index += 1) {
        if (lines[index].trim() === "---") {
            endIndex = index;
            break;
        }
    }
    if (endIndex < 0) return raw;
    return lines.slice(endIndex + 1).join("\n").trim();
}

function hasAllowedToolIntersection(allowedTools: string[], activeTools: string[]): boolean {
    if (allowedTools.length === 0) return true;
    const active = new Set(activeTools);
    return allowedTools.some((toolId) => active.has(toolId));
}

function scoreSkill(prompt: string, triggers: string[], content: string): number {
    const promptTokens = new Set(tokenize(prompt));
    if (promptTokens.size === 0) return 0;
    let score = 0;

    for (const trigger of triggers) {
        const triggerTokens = tokenize(trigger);
        if (triggerTokens.length === 0) continue;
        let overlap = 0;
        for (const token of triggerTokens) {
            if (promptTokens.has(token)) overlap += 1;
        }
        if (overlap > 0) {
            score += overlap / triggerTokens.length;
        }
    }

    if (score === 0) {
        const contentTokens = tokenize(content).slice(0, 150);
        let overlap = 0;
        for (const token of contentTokens) {
            if (promptTokens.has(token)) overlap += 1;
        }
        score += overlap > 0 ? overlap / Math.max(1, contentTokens.length) : 0;
    }

    return score;
}

export async function loadRuntimeSkills(agent: AgentConfig): Promise<RuntimeSkill[]> {
    const workspace = resolveAgentWorkspacePaths(agent);
    const skillsDirPath = path.join(workspace.rootAbsolutePath, SKILLS_DIR);
    let entries: Dirent<string>[] = [];
    try {
        entries = await fs.readdir(skillsDirPath, { withFileTypes: true, encoding: "utf8" });
    } catch {
        return [];
    }

    const markdownFiles = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
        .filter((entry) => entry.name.toLowerCase() !== "skill_index.md");

    const loaded = await Promise.all(markdownFiles.map(async (entry) => {
        const absolutePath = path.join(skillsDirPath, entry.name);
        const raw = await fs.readFile(absolutePath, "utf-8");
        const frontmatter = parseFrontmatter(raw);
        const content = stripFrontmatter(raw);
        const name = entry.name.replace(/\.md$/i, "");
        return {
            id: name.toLowerCase(),
            name,
            path: absolutePath,
            content,
            triggers: frontmatter.triggers,
            allowedTools: normalizeToolIds(frontmatter.allowedTools),
            score: 0,
        } satisfies RuntimeSkill;
    }));

    return loaded;
}

export function selectRelevantRuntimeSkills(
    skills: RuntimeSkill[],
    prompt: string,
    activeToolIds: string[],
    options?: { limit?: number; minScore?: number },
): RuntimeSkill[] {
    const limit = Math.max(1, Math.min(8, Math.floor(options?.limit ?? 3)));
    const minScore = typeof options?.minScore === "number" ? options.minScore : 0.05;

    const scored = skills
        .filter((skill) => hasAllowedToolIntersection(skill.allowedTools, activeToolIds))
        .map((skill) => ({
            ...skill,
            score: scoreSkill(prompt, skill.triggers, skill.content),
        }))
        .filter((skill) => skill.score >= minScore)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);

    return scored;
}

function truncateSkillContent(content: string, maxChars = 2000): string {
    const trimmed = content.trim();
    if (trimmed.length <= maxChars) return trimmed;
    return `${trimmed.slice(0, maxChars - 1).trimEnd()}...`;
}

export function buildRuntimeSkillsPrompt(skills: RuntimeSkill[]): string {
    if (skills.length === 0) return "";
    const lines: string[] = [
        "### Active Skills",
        "Apply these skills when they are relevant to the current request.",
    ];
    for (const skill of skills) {
        lines.push("");
        lines.push(`#### ${skill.name}`);
        if (skill.allowedTools.length > 0) {
            lines.push(`Allowed tools: ${skill.allowedTools.join(", ")}`);
        }
        lines.push(truncateSkillContent(skill.content));
    }
    return lines.join("\n");
}
