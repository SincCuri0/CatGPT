import { NextRequest, NextResponse } from "next/server";
import { providerRegistry } from "@/lib/llm/ProviderRegistry";
import { getEnvVariable } from "@/lib/env";

const PROVIDER_ENV_KEY_MAP: Record<string, string> = {
    groq: "GROQ_API_KEY",
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GEMINI_API_KEY",
};

async function resolveApiKeys(req: NextRequest): Promise<Record<string, string | null>> {
    const rawHeaderKeys = req.headers.get("x-api-keys");
    let clientKeys: Record<string, string> = {};

    if (rawHeaderKeys) {
        try {
            const parsed = JSON.parse(rawHeaderKeys);
            if (parsed && typeof parsed === "object") {
                clientKeys = parsed;
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

function buildGenerationPrompt(
    name: string,
    role: string,
    style: string,
    description: string,
    existingInstructions: string,
): string {
    return [
        "Generate a production-quality system prompt for an AI agent.",
        "",
        "The prompt must:",
        "- Define how this agent behaves, what it knows, and what it should avoid.",
        "- Align behavior and response tone with the provided role and personality style.",
        "- Be specific, practical, and ready to use as a system prompt.",
        "- Include clear sections (for example: role, goals, behavior, constraints, style, and failure handling).",
        "- Keep a concise but detailed tone.",
        "- Return only the final system prompt text, with no preface or markdown fences.",
        "",
        "Agent details:",
        `Name: ${name || "(not provided)"}`,
        `Role: ${role || "(not provided)"}`,
        `Personality style: ${style || "(not provided)"}`,
        `Description: ${description || "(not provided)"}`,
        "",
        "Existing instructions (if any):",
        existingInstructions || "(none)",
    ].join("\n");
}

export async function POST(req: NextRequest) {
    try {
        const apiKeys = await resolveApiKeys(req);
        const body = await req.json();

        const provider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : "groq";
        const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const role = typeof body.role === "string" ? body.role.trim() : "";
        const style = typeof body.style === "string" ? body.style.trim() : "";
        const description = typeof body.description === "string" ? body.description.trim() : "";
        const existingInstructions = typeof body.existingInstructions === "string" ? body.existingInstructions.trim() : "";

        const providerApiKey = apiKeys[provider];
        if (!providerApiKey) {
            return NextResponse.json(
                { error: `API key missing for provider '${provider}'.` },
                { status: 401 },
            );
        }

        const llm = providerRegistry.createClient(provider, providerApiKey, model);

        const response = await llm.chat([
            {
                role: "system",
                content: "You are an expert prompt engineer. Produce high-quality, reliable system prompts for AI agents.",
            },
            {
                role: "user",
                content: buildGenerationPrompt(name, role, style, description, existingInstructions),
            },
        ], {
            temperature: 0.4,
            max_tokens: 1800,
        });

        const instructions = response.content?.trim();
        if (!instructions) {
            return NextResponse.json({ error: "Model returned empty instructions." }, { status: 502 });
        }

        return NextResponse.json({ instructions });
    } catch (error: unknown) {
        console.error("Generate Instructions API Error:", error);
        const message = getErrorMessage(error);

        if (message.toLowerCase().includes("api key") || message.toLowerCase().includes("unauthorized")) {
            return NextResponse.json({ error: message }, { status: 401 });
        }

        return NextResponse.json(
            { error: "Failed to generate instructions", details: message },
            { status: 500 },
        );
    }
}
