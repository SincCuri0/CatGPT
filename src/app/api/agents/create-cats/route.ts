import { NextRequest, NextResponse } from "next/server";
import { providerRegistry } from "@/lib/llm/ProviderRegistry";
import { getEnvVariable } from "@/lib/env";
import type { AgentStyle } from "@/lib/core/Agent";
import { DEFAULT_REASONING_EFFORT, PROVIDERS } from "@/lib/llm/constants";
import type { ReasoningEffort } from "@/lib/llm/types";
import { isModelChatCapable, supportsReasoningEffort } from "@/lib/llm/modelCatalog";
import { debugRouteError, debugRouteLog, isDebugRequest } from "@/lib/debug/server";

const PROVIDER_ENV_KEY_MAP: Record<string, string> = {
    groq: "GROQ_API_KEY",
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GEMINI_API_KEY",
};

const ALLOWED_TOOL_IDS = new Set(["web_search", "fs_read", "fs_write", "shell_execute"]);
const ALLOWED_STYLES = new Set<AgentStyle>(["assistant", "character", "expert", "custom"]);

interface ExistingAgentSummary {
    name: string;
    role: string;
}

interface GeneratedAgentDraft {
    name: string;
    role: string;
    description: string;
    style: AgentStyle;
    systemPrompt: string;
    tools: string[];
    provider: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    voiceId: string;
}

interface CreateAgentsResult {
    action: "create_agents";
    summary: string;
    agents: GeneratedAgentDraft[];
}

interface RequestInformationResult {
    action: "request_information";
    question: string;
    reason?: string;
}

type CreateCatsResult = CreateAgentsResult | RequestInformationResult;

interface NormalizeContext {
    userPrompt: string;
    defaultProvider: string;
    defaultModel: string;
    defaultReasoningEffort: ReasoningEffort;
    existingNames: Set<string>;
}

interface CreateCatsRequestBody {
    prompt?: unknown;
    provider?: unknown;
    model?: unknown;
    reasoningEffort?: unknown;
    existingAgents?: unknown;
}

async function resolveApiKeys(req: NextRequest): Promise<Record<string, string | null>> {
    const rawHeaderKeys = req.headers.get("x-api-keys");
    let clientKeys: Record<string, string> = {};

    if (rawHeaderKeys) {
        try {
            const parsed = JSON.parse(rawHeaderKeys);
            if (parsed && typeof parsed === "object") {
                clientKeys = parsed as Record<string, string>;
            }
        } catch {
            // Ignore malformed header and rely on env fallback.
        }
    }

    const legacyGroq = req.headers.get("x-groq-api-key");
    if (legacyGroq && legacyGroq !== "null") {
        clientKeys.groq = legacyGroq;
    }

    const resolved: Record<string, string | null> = {};
    for (const [providerId, envVar] of Object.entries(PROVIDER_ENV_KEY_MAP)) {
        const providedKey = clientKeys[providerId];
        if (typeof providedKey === "string" && providedKey.trim().length > 0 && providedKey !== "null") {
            resolved[providerId] = providedKey.trim();
        } else {
            resolved[providerId] = await getEnvVariable(envVar);
        }
    }

    return resolved;
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return "Unknown error";
}

function isProviderSupported(providerId: string): boolean {
    return PROVIDERS.some((provider) => provider.id === providerId);
}

function defaultModelForProvider(providerId: string): string {
    const provider = PROVIDERS.find((candidate) => candidate.id === providerId);
    return provider?.defaultModel || "llama-3.3-70b-versatile";
}

function sanitizeText(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort {
    if (value === "none" || value === "low" || value === "medium" || value === "high") {
        return value;
    }
    return DEFAULT_REASONING_EFFORT;
}

function sanitizeStyle(value: unknown): AgentStyle {
    if (typeof value === "string" && ALLOWED_STYLES.has(value as AgentStyle)) {
        return value as AgentStyle;
    }
    return "assistant";
}

function sanitizeTools(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const deduped = new Set<string>();

    for (const tool of value) {
        if (typeof tool !== "string") continue;
        const normalized = tool.trim();
        if (!ALLOWED_TOOL_IDS.has(normalized)) continue;
        deduped.add(normalized);
    }

    return Array.from(deduped);
}

function canGenerateAgentFromPrompt(prompt: string): boolean {
    const normalized = prompt.trim();
    if (!normalized) return false;
    const tokenCount = normalized.split(/\s+/).filter(Boolean).length;
    return tokenCount >= 2;
}

function extractJsonCandidate(raw: string): string {
    const cleaned = raw
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();

    if (cleaned.startsWith("{") && cleaned.endsWith("}")) {
        return cleaned;
    }

    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
        return cleaned.slice(start, end + 1);
    }

    return cleaned;
}

function parseResponseJson(raw: string): Record<string, unknown> {
    const candidate = extractJsonCandidate(raw);
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Model response must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
}

function toExistingAgents(value: unknown): ExistingAgentSummary[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return null;
            const record = item as Record<string, unknown>;
            const name = sanitizeText(record.name);
            const role = sanitizeText(record.role);
            if (!name) return null;
            return { name, role };
        })
        .filter((item): item is ExistingAgentSummary => Boolean(item));
}

function makeUniqueName(baseName: string, existingNames: Set<string>): string {
    const base = baseName.trim() || "New Cat";
    if (!existingNames.has(base.toLowerCase())) {
        existingNames.add(base.toLowerCase());
        return base;
    }

    let index = 2;
    while (true) {
        const candidate = `${base} ${index}`;
        const normalized = candidate.toLowerCase();
        if (!existingNames.has(normalized)) {
            existingNames.add(normalized);
            return candidate;
        }
        index += 1;
    }
}

function buildDefaultSystemPrompt(name: string, role: string, description: string, userPrompt: string): string {
    const roleLine = role || "Specialist Assistant";
    const summary = description || `Help with the user's request: ${userPrompt}`;

    return [
        `You are ${name}, a ${roleLine}.`,
        "",
        "Role and Scope:",
        `- Focus area: ${summary}`,
        "- Stay aligned with the user's explicit goals and constraints.",
        "",
        "Behavior:",
        "- Be clear, practical, and concise.",
        "- Ask a clarifying question only when a critical detail blocks useful progress.",
        "- Explain assumptions when details are missing.",
        "",
        "Quality and Safety:",
        "- Do not fabricate facts, outputs, or completed actions.",
        "- If uncertain, state what is unknown and provide the best next step.",
        "",
        "Output Style:",
        "- Use short sections or bullets when it improves readability.",
        "- End with actionable next steps when appropriate.",
    ].join("\n");
}

function buildFallbackAgent(context: NormalizeContext): GeneratedAgentDraft | null {
    if (!canGenerateAgentFromPrompt(context.userPrompt)) return null;

    const name = makeUniqueName("Task Planner Cat", context.existingNames);
    const role = "General Task Specialist";
    const description = `Handles the request: ${context.userPrompt}`;

    return {
        name,
        role,
        description,
        style: "assistant",
        systemPrompt: buildDefaultSystemPrompt(name, role, description, context.userPrompt),
        tools: [],
        provider: context.defaultProvider,
        model: context.defaultModel,
        reasoningEffort: context.defaultReasoningEffort,
        voiceId: "en-US-ChristopherNeural",
    };
}

function normalizeAgentDraft(
    value: unknown,
    index: number,
    context: NormalizeContext,
): GeneratedAgentDraft | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;

    const nameFromModel = sanitizeText(record.name);
    const role = sanitizeText(record.role) || "Specialist Assistant";
    const description = sanitizeText(record.description);
    const style = sanitizeStyle(record.style);

    const providerCandidate = sanitizeText(record.provider).toLowerCase();
    const provider = isProviderSupported(providerCandidate) ? providerCandidate : context.defaultProvider;

    const modelCandidate = sanitizeText(record.model);
    const initialModel = modelCandidate || (provider === context.defaultProvider
        ? context.defaultModel
        : defaultModelForProvider(provider));
    const model = isModelChatCapable({ id: initialModel }, provider)
        ? initialModel
        : defaultModelForProvider(provider);
    const reasoningEffort = typeof record.reasoningEffort === "string"
        ? normalizeReasoningEffort(record.reasoningEffort)
        : context.defaultReasoningEffort;
    const safeReasoningEffort = supportsReasoningEffort(provider, model)
        ? reasoningEffort
        : "none";

    const voiceId = sanitizeText(record.voiceId) || "en-US-ChristopherNeural";
    const tools = sanitizeTools(record.tools);

    const fallbackName = `${role} Cat ${index + 1}`;
    const name = makeUniqueName(nameFromModel || fallbackName, context.existingNames);
    const systemPromptRaw = sanitizeText(record.systemPrompt);
    const systemPrompt = systemPromptRaw || buildDefaultSystemPrompt(name, role, description, context.userPrompt);

    return {
        name,
        role,
        description,
        style,
        systemPrompt,
        tools,
        provider,
        model,
        reasoningEffort: safeReasoningEffort,
        voiceId,
    };
}

function normalizeModelResult(rawModelOutput: string, context: NormalizeContext): CreateCatsResult {
    let parsed: Record<string, unknown>;
    try {
        parsed = parseResponseJson(rawModelOutput);
    } catch {
        const fallback = buildFallbackAgent(context);
        if (fallback) {
            return {
                action: "create_agents",
                summary: "Created a starter cat from your request.",
                agents: [fallback],
            };
        }

        return {
            action: "request_information",
            question: "What should the new cat agent(s) do? Include goals, tasks, or responsibilities.",
        };
    }

    const action = sanitizeText(parsed.action).toLowerCase();
    const summary = sanitizeText(parsed.summary) || "Created new cat agent(s) from your request.";
    const reason = sanitizeText(parsed.reason);
    const question = sanitizeText(parsed.question) || "What should the new cat agent(s) do?";

    if (action === "create_agents") {
        const sourceAgents = Array.isArray(parsed.agents) ? parsed.agents : [];
        const normalizedAgents = sourceAgents
            .map((agent, index) => normalizeAgentDraft(agent, index, context))
            .filter((agent): agent is GeneratedAgentDraft => Boolean(agent));

        if (normalizedAgents.length > 0) {
            return {
                action: "create_agents",
                summary,
                agents: normalizedAgents,
            };
        }
    }

    if (action === "request_information" && !canGenerateAgentFromPrompt(context.userPrompt)) {
        return {
            action: "request_information",
            question,
            reason: reason || undefined,
        };
    }

    const fallback = buildFallbackAgent(context);
    if (fallback) {
        return {
            action: "create_agents",
            summary: "Created a starter cat from your request.",
            agents: [fallback],
        };
    }

    return {
        action: "request_information",
        question,
        reason: reason || undefined,
    };
}

function buildPlannerPrompt(
    userPrompt: string,
    existingAgents: ExistingAgentSummary[],
    defaultProvider: string,
    defaultModel: string,
    defaultReasoningEffort: ReasoningEffort,
): string {
    const existingList = existingAgents.length > 0
        ? existingAgents.map((agent) => `- ${agent.name} (${agent.role || "unspecified role"})`).join("\n")
        : "(none)";

    return [
        "Create agent definitions from the user's request.",
        "Output JSON only and follow this schema exactly:",
        "{",
        '  "action": "create_agents" | "request_information",',
        '  "summary": "short plain-English summary",',
        '  "agents": [',
        "    {",
        '      "name": "string",',
        '      "role": "string",',
        '      "description": "string",',
        '      "style": "assistant|character|expert|custom",',
        '      "systemPrompt": "string",',
        '      "tools": ["web_search"|"fs_read"|"fs_write"|"shell_execute"],',
        '      "provider": "groq|openai|anthropic|google",',
        '      "model": "string",',
        '      "reasoningEffort": "none|low|medium|high",',
        '      "voiceId": "string"',
        "    }",
        "  ],",
        '  "question": "single clarifying question when action=request_information",',
        '  "reason": "optional short reason"',
        "}",
        "",
        "Rules:",
        "- Prefer action=create_agents whenever at least one useful systemPrompt can be produced.",
        "- Use action=request_information only when no meaningful systemPrompt can be generated.",
        "- If the user asks for multiple responsibilities, create multiple specialized agents.",
        "- Keep each systemPrompt production-ready, explicit, and practical.",
        "- Avoid duplicating existing agents unless the user explicitly asks for overlap.",
        "",
        `Default provider if not specified: ${defaultProvider}`,
        `Default model if not specified: ${defaultModel}`,
        `Default reasoningEffort if not specified: ${defaultReasoningEffort}`,
        "Existing agents:",
        existingList,
        "",
        "User request:",
        userPrompt,
    ].join("\n");
}

export async function POST(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    try {
        debugRouteLog(debugEnabled, "api/agents/create-cats", "POST request started");
        const apiKeys = await resolveApiKeys(req);
        const body = (await req.json()) as CreateCatsRequestBody;

        const userPrompt = sanitizeText(body.prompt);
        const preferredProviderRaw = sanitizeText(body.provider).toLowerCase();
        const preferredProvider = isProviderSupported(preferredProviderRaw) ? preferredProviderRaw : "groq";
        const preferredModel = sanitizeText(body.model);
        const preferredReasoningEffort = normalizeReasoningEffort(body.reasoningEffort);
        const existingAgents = toExistingAgents(body.existingAgents);

        if (!userPrompt) {
            debugRouteLog(debugEnabled, "api/agents/create-cats", "Request missing prompt; asking for more information");
            return NextResponse.json({
                action: "request_information",
                question: "Tell me what kind of cat agent(s) you want to create and what they should do.",
            } satisfies RequestInformationResult);
        }
        debugRouteLog(debugEnabled, "api/agents/create-cats", "Parsed create-cats request", {
            preferredProvider,
            hasPreferredModel: Boolean(preferredModel),
            existingAgents: existingAgents.length,
        });

        const providerSearchOrder = [
            preferredProvider,
            ...Object.keys(PROVIDER_ENV_KEY_MAP).filter((providerId) => providerId !== preferredProvider),
        ];

        let activeProvider: string | null = null;
        let activeApiKey: string | null = null;
        for (const providerId of providerSearchOrder) {
            const key = apiKeys[providerId];
            if (key) {
                activeProvider = providerId;
                activeApiKey = key;
                break;
            }
        }

        if (!activeProvider || !activeApiKey) {
            debugRouteLog(debugEnabled, "api/agents/create-cats", "No provider API key available");
            return NextResponse.json(
                { error: "No provider API key found for create-cats." },
                { status: 401 },
            );
        }

        const activeModelCandidate = activeProvider === preferredProvider && preferredModel
            ? preferredModel
            : defaultModelForProvider(activeProvider);
        const activeModel = isModelChatCapable({ id: activeModelCandidate }, activeProvider)
            ? activeModelCandidate
            : defaultModelForProvider(activeProvider);

        const llm = providerRegistry.createClient(activeProvider, activeApiKey, activeModel);
        const llmResponse = await llm.chat([
            {
                role: "system",
                content: "You are a senior AI agent architect. Return strict JSON only.",
            },
            {
                role: "user",
                content: buildPlannerPrompt(userPrompt, existingAgents, activeProvider, activeModel, preferredReasoningEffort),
            },
        ], {
            temperature: 0.25,
            max_tokens: 2200,
            reasoningEffort: preferredReasoningEffort,
        });

        const normalized = normalizeModelResult(llmResponse.content || "", {
            userPrompt,
            defaultProvider: activeProvider,
            defaultModel: activeModel,
            defaultReasoningEffort: preferredReasoningEffort,
            existingNames: new Set(existingAgents.map((agent) => agent.name.toLowerCase())),
        });
        debugRouteLog(debugEnabled, "api/agents/create-cats", "Create-cats response prepared", {
            action: normalized.action,
            generatedAgents: normalized.action === "create_agents" ? normalized.agents.length : 0,
        });

        return NextResponse.json(normalized satisfies CreateCatsResult);
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/agents/create-cats", "Unhandled error in POST", error);
        console.error("Create Cats API Error:", error);
        const message = getErrorMessage(error);

        if (message.toLowerCase().includes("api key") || message.toLowerCase().includes("unauthorized")) {
            return NextResponse.json({ error: message }, { status: 401 });
        }

        return NextResponse.json(
            { error: "Failed to interpret create_cats request", details: message },
            { status: 500 },
        );
    }
}
