import { NextRequest, NextResponse } from "next/server";
import { providerRegistry } from "@/lib/llm/ProviderRegistry";
import { DEFAULT_REASONING_EFFORT } from "@/lib/llm/constants";
import type { ReasoningEffort } from "@/lib/llm/types";
import { debugRouteError, debugRouteLog } from "@/lib/debug/server";
import { resolveApiKeys } from "@/lib/api/resolveApiKeys";
import { getErrorMessage } from "@/lib/runtime/kernel/validation";

function normalizeReasoningEffort(value: unknown): ReasoningEffort {
    if (value === "none" || value === "low" || value === "medium" || value === "high") {
        return value;
    }
    return DEFAULT_REASONING_EFFORT;
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

export async function executeAgentsGenerateInstructionsPost(req: NextRequest, debugEnabled: boolean): Promise<Response> {
    try {
        debugRouteLog(debugEnabled, "api/agents/generate-instructions", "POST request started");
        const apiKeys = await resolveApiKeys(req);
        const body = await req.json();

        const provider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : "groq";
        const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const role = typeof body.role === "string" ? body.role.trim() : "";
        const style = typeof body.style === "string" ? body.style.trim() : "";
        const description = typeof body.description === "string" ? body.description.trim() : "";
        const existingInstructions = typeof body.existingInstructions === "string" ? body.existingInstructions.trim() : "";
        const reasoningEffort = normalizeReasoningEffort(body.reasoningEffort);

        const providerApiKey = apiKeys[provider];
        if (!providerApiKey) {
            debugRouteLog(debugEnabled, "api/agents/generate-instructions", "Missing API key for provider", { provider });
            return NextResponse.json(
                { error: `API key missing for provider '${provider}'.` },
                { status: 401 },
            );
        }
        debugRouteLog(debugEnabled, "api/agents/generate-instructions", "Generating prompt", {
            provider,
            model: model || "default",
            reasoningEffort,
            hasExistingInstructions: Boolean(existingInstructions),
        });

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
            reasoningEffort,
        });

        const instructions = response.content?.trim();
        if (!instructions) {
            debugRouteLog(debugEnabled, "api/agents/generate-instructions", "Model returned empty instructions");
            return NextResponse.json({ error: "Model returned empty instructions." }, { status: 502 });
        }

        debugRouteLog(debugEnabled, "api/agents/generate-instructions", "Instructions generated", {
            instructionLength: instructions.length,
        });
        return NextResponse.json({ instructions });
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/agents/generate-instructions", "Unhandled error in POST", error);
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

