import type { AgentConfig, AgentStyle } from "../core/Agent";
import type { ReasoningEffort } from "../llm/types";
import { isKnownDeprecatedModel } from "../llm/modelCatalog";
import { SquadConfig, normalizeSquadConfig } from "../core/Squad";

export const SQUAD_BLUEPRINT_VERSION = 1 as const;
export const SQUAD_BLUEPRINT_KIND = "cat_gpt_squad_blueprint";
export const SQUAD_BLUEPRINT_BUNDLE_KIND = "cat_gpt_squad_blueprint_bundle";

const VALID_AGENT_STYLES = new Set<AgentStyle>(["assistant", "character", "expert", "custom"]);
const VALID_REASONING_EFFORTS = new Set<ReasoningEffort>(["none", "low", "medium", "high"]);

export interface SquadBlueprintAgent {
    key: string;
    name: string;
    role: string;
    systemPrompt: string;
    description?: string;
    style?: AgentStyle;
    voiceId?: string;
    provider?: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    tools?: string[];
}

export interface SquadBlueprintDefinition {
    id: string;
    version: typeof SQUAD_BLUEPRINT_VERSION;
    name: string;
    description: string;
    category: string;
    tags: string[];
    author?: string;
    squad: Omit<SquadConfig, "id">;
    agents: SquadBlueprintAgent[];
}

export interface SquadBlueprintExportPayload {
    kind: typeof SQUAD_BLUEPRINT_KIND;
    version: typeof SQUAD_BLUEPRINT_VERSION;
    exportedAt: string;
    blueprint: SquadBlueprintDefinition;
}

interface SquadBlueprintBundlePayload {
    kind: typeof SQUAD_BLUEPRINT_BUNDLE_KIND;
    version: typeof SQUAD_BLUEPRINT_VERSION;
    exportedAt: string;
    blueprints: SquadBlueprintDefinition[];
}

interface CreateBlueprintOptions {
    id?: string;
    name?: string;
    description?: string;
    category?: string;
    tags?: string[];
    author?: string;
}

interface InstantiateBlueprintOptions {
    existingSquads: SquadConfig[];
    existingSquadAgents: AgentConfig[];
    createId: () => string;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (typeof item !== "string") continue;
        const text = item.trim();
        if (!text) continue;
        const normalized = text.toLowerCase();
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(text);
    }
    return out;
}

function normalizeStyle(value: unknown): AgentStyle | undefined {
    if (typeof value !== "string") return undefined;
    return VALID_AGENT_STYLES.has(value as AgentStyle) ? value as AgentStyle : undefined;
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
    if (typeof value !== "string") return undefined;
    return VALID_REASONING_EFFORTS.has(value as ReasoningEffort) ? value as ReasoningEffort : undefined;
}

function slugify(value: string): string {
    const safe = value
        .toLowerCase()
        .replace(/[^a-z0-9 -_]+/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
    return safe || "blueprint";
}

function uniqueName(baseName: string, takenNames: Set<string>): string {
    const base = baseName.trim() || "Untitled";
    const normalizedBase = base.toLowerCase();
    if (!takenNames.has(normalizedBase)) {
        takenNames.add(normalizedBase);
        return base;
    }

    let suffix = 2;
    while (true) {
        const candidate = `${base} ${suffix}`;
        const normalizedCandidate = candidate.toLowerCase();
        if (!takenNames.has(normalizedCandidate)) {
            takenNames.add(normalizedCandidate);
            return candidate;
        }
        suffix += 1;
    }
}

function normalizeBlueprintAgent(value: unknown, fallbackIndex: number): SquadBlueprintAgent | null {
    if (!isObject(value)) return null;

    const key = asText(value.key) || `agent-${fallbackIndex + 1}`;
    const name = asText(value.name) || `Squad Agent ${fallbackIndex + 1}`;
    const role = asText(value.role) || "Assistant";
    const systemPrompt = asText(value.systemPrompt) || `You are ${name}, a ${role}.`;
    const description = asText(value.description);
    const voiceId = asText(value.voiceId);
    const provider = asText(value.provider).toLowerCase();
    const requestedModel = asText(value.model);
    const model = requestedModel && !isKnownDeprecatedModel(provider, requestedModel)
        ? requestedModel
        : "";
    const tools = asStringArray(value.tools);
    const style = normalizeStyle(value.style);
    const reasoningEffort = normalizeReasoningEffort(value.reasoningEffort);

    return {
        key,
        name,
        role,
        systemPrompt,
        ...(description ? { description } : {}),
        ...(style ? { style } : {}),
        ...(voiceId ? { voiceId } : {}),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(tools.length > 0 ? { tools } : {}),
    };
}

export function normalizeBlueprintDefinition(raw: unknown): SquadBlueprintDefinition | null {
    if (!isObject(raw)) return null;

    const name = asText(raw.name);
    if (!name) return null;

    const id = asText(raw.id) || slugify(name);
    const category = asText(raw.category) || "General";
    const description = asText(raw.description) || `${name} workflow blueprint.`;
    const author = asText(raw.author);
    const tags = asStringArray(raw.tags);

    const agentsInput = Array.isArray(raw.agents) ? raw.agents : [];
    const seenKeys = new Set<string>();
    const normalizedAgents: SquadBlueprintAgent[] = [];

    for (let index = 0; index < agentsInput.length; index += 1) {
        const normalized = normalizeBlueprintAgent(agentsInput[index], index);
        if (!normalized) continue;
        let key = normalized.key;
        let nextSuffix = 2;
        while (seenKeys.has(key)) {
            key = `${normalized.key}-${nextSuffix}`;
            nextSuffix += 1;
        }
        seenKeys.add(key);
        normalizedAgents.push({ ...normalized, key });
    }

    if (normalizedAgents.length === 0) return null;

    const squadInput = isObject(raw.squad) ? raw.squad : {};
    const requestedMemberKeys = asStringArray(squadInput.members);
    const memberKeys = requestedMemberKeys
        .filter((memberKey) => seenKeys.has(memberKey));
    const effectiveMemberKeys = memberKeys.length > 0
        ? memberKeys
        : normalizedAgents.map((agent) => agent.key);

    const normalizedSquad = normalizeSquadConfig({
        name: asText(squadInput.name) || name,
        goal: asText(squadInput.goal) || description,
        context: asText(squadInput.context),
        mission: asText(squadInput.mission),
        members: effectiveMemberKeys,
        maxIterations: typeof squadInput.maxIterations === "number" ? squadInput.maxIterations : undefined,
        orchestrator: isObject(squadInput.orchestrator) ? squadInput.orchestrator : undefined,
        interaction: isObject(squadInput.interaction) ? squadInput.interaction : undefined,
    });

    return {
        id,
        version: SQUAD_BLUEPRINT_VERSION,
        name,
        description,
        category,
        tags,
        ...(author ? { author } : {}),
        squad: {
            name: normalizedSquad.name,
            goal: normalizedSquad.goal,
            context: normalizedSquad.context,
            mission: normalizedSquad.mission,
            members: effectiveMemberKeys,
            maxIterations: normalizedSquad.maxIterations,
            orchestrator: normalizedSquad.orchestrator,
            interaction: normalizedSquad.interaction,
        },
        agents: normalizedAgents,
    };
}

export function normalizeBlueprintList(raw: unknown): SquadBlueprintDefinition[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((entry) => normalizeBlueprintDefinition(entry))
        .filter((entry): entry is SquadBlueprintDefinition => Boolean(entry));
}

export function parseBlueprintText(jsonText: string): SquadBlueprintDefinition[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        throw new Error("Invalid JSON. Please paste a valid Squad Blueprint payload.");
    }

    const fromPlain = normalizeBlueprintDefinition(parsed);
    if (fromPlain) {
        return [fromPlain];
    }

    if (isObject(parsed) && parsed.kind === SQUAD_BLUEPRINT_KIND) {
        const item = normalizeBlueprintDefinition(parsed.blueprint);
        if (!item) throw new Error("Blueprint payload is missing a valid 'blueprint' object.");
        return [item];
    }

    if (isObject(parsed) && parsed.kind === SQUAD_BLUEPRINT_BUNDLE_KIND) {
        const bundleItems = normalizeBlueprintList(parsed.blueprints);
        if (bundleItems.length === 0) {
            throw new Error("Blueprint bundle did not contain any valid blueprints.");
        }
        return bundleItems;
    }

    if (Array.isArray(parsed)) {
        const items = normalizeBlueprintList(parsed);
        if (items.length === 0) {
            throw new Error("No valid Squad Blueprint entries found in the JSON array.");
        }
        return items;
    }

    throw new Error("Unsupported payload format. Expected a blueprint object, export payload, or array.");
}

export function createBlueprintExportPayload(blueprint: SquadBlueprintDefinition): SquadBlueprintExportPayload {
    return {
        kind: SQUAD_BLUEPRINT_KIND,
        version: SQUAD_BLUEPRINT_VERSION,
        exportedAt: new Date().toISOString(),
        blueprint,
    };
}

export function createBlueprintBundleExportPayload(blueprints: SquadBlueprintDefinition[]): SquadBlueprintBundlePayload {
    return {
        kind: SQUAD_BLUEPRINT_BUNDLE_KIND,
        version: SQUAD_BLUEPRINT_VERSION,
        exportedAt: new Date().toISOString(),
        blueprints,
    };
}

export function serializeBlueprintForShare(blueprint: SquadBlueprintDefinition): string {
    return JSON.stringify(createBlueprintExportPayload(blueprint), null, 2);
}

export function createBlueprintFromSquad(
    squad: SquadConfig,
    memberAgents: AgentConfig[],
    options?: CreateBlueprintOptions,
): SquadBlueprintDefinition | null {
    if (memberAgents.length === 0) return null;

    const normalizedSquad = normalizeSquadConfig(squad);
    const usedKeys = new Set<string>();
    const agentIdToKey = new Map<string, string>();
    const blueprintAgents: SquadBlueprintAgent[] = memberAgents.map((agent, index) => {
        const requestedKey = slugify(agent.name || `agent-${index + 1}`);
        let key = requestedKey;
        let suffix = 2;
        while (usedKeys.has(key)) {
            key = `${requestedKey}-${suffix}`;
            suffix += 1;
        }
        usedKeys.add(key);
        if (agent.id) {
            agentIdToKey.set(agent.id, key);
        }

        return {
            key,
            name: agent.name || `Agent ${index + 1}`,
            role: agent.role || "Assistant",
            systemPrompt: agent.systemPrompt || `You are ${agent.name || `Agent ${index + 1}`}.`,
            ...(agent.description ? { description: agent.description } : {}),
            ...(agent.style ? { style: agent.style } : {}),
            ...(agent.voiceId ? { voiceId: agent.voiceId } : {}),
            ...(agent.provider ? { provider: agent.provider } : {}),
            ...(agent.model ? { model: agent.model } : {}),
            ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
            ...(agent.tools ? { tools: agent.tools } : {}),
        };
    });

    const mappedMembers = normalizedSquad.members
        .map((memberId) => agentIdToKey.get(memberId))
        .filter((member): member is string => Boolean(member));
    const members = mappedMembers.length > 0
        ? mappedMembers
        : blueprintAgents.map((agent) => agent.key);

    const rawName = options?.name?.trim() || `${normalizedSquad.name || "Squad"} Blueprint`;
    const normalized = normalizeBlueprintDefinition({
        id: options?.id || `custom-${slugify(rawName)}`,
        version: SQUAD_BLUEPRINT_VERSION,
        name: rawName,
        description: options?.description || normalizedSquad.goal || `${normalizedSquad.name} workflow.`,
        category: options?.category || "Custom",
        tags: options?.tags || [],
        author: options?.author || "Local User",
        squad: {
            name: normalizedSquad.name,
            goal: normalizedSquad.goal,
            context: normalizedSquad.context,
            mission: normalizedSquad.mission,
            members,
            maxIterations: normalizedSquad.maxIterations,
            orchestrator: normalizedSquad.orchestrator,
            interaction: normalizedSquad.interaction,
        },
        agents: blueprintAgents,
    });

    return normalized;
}

export function instantiateBlueprint(
    blueprint: SquadBlueprintDefinition,
    options: InstantiateBlueprintOptions,
): { squad: SquadConfig; agents: AgentConfig[] } {
    const existingAgentNames = new Set(
        options.existingSquadAgents
            .map((agent) => (agent.name || "").trim().toLowerCase())
            .filter((name) => Boolean(name)),
    );
    const existingSquadNames = new Set(
        options.existingSquads
            .map((squad) => (squad.name || "").trim().toLowerCase())
            .filter((name) => Boolean(name)),
    );

    const keyToAgentId = new Map<string, string>();
    const agents = blueprint.agents.map((agent) => {
        const name = uniqueName(agent.name, existingAgentNames);
        const id = options.createId();
        keyToAgentId.set(agent.key, id);

        return {
            id,
            name,
            role: agent.role,
            description: agent.description,
            style: agent.style,
            systemPrompt: agent.systemPrompt,
            voiceId: agent.voiceId,
            provider: agent.provider,
            model: agent.model,
            reasoningEffort: agent.reasoningEffort,
            tools: agent.tools || [],
        } satisfies AgentConfig;
    });

    const memberIds = blueprint.squad.members
        .map((memberKey) => keyToAgentId.get(memberKey))
        .filter((memberId): memberId is string => Boolean(memberId));
    const effectiveMemberIds = memberIds.length > 0
        ? memberIds
        : agents.map((agent) => agent.id || "").filter((id) => Boolean(id));
    const squadName = uniqueName(blueprint.squad.name || blueprint.name, existingSquadNames);
    const normalizedSquad = normalizeSquadConfig({
        ...blueprint.squad,
        name: squadName,
        members: effectiveMemberIds,
    });

    return {
        agents,
        squad: {
            ...normalizedSquad,
            id: options.createId(),
        },
    };
}
