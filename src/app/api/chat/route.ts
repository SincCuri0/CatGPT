import { NextRequest, NextResponse } from "next/server";
import { Agent, AgentApiKeys, AgentConfig } from "@/lib/core/Agent";
import { Message } from "@/lib/core/types";
import { toolRegistry } from "@/lib/core/ToolRegistry";
import { getEnvVariable } from "@/lib/env";
import { SquadConfig } from "@/lib/core/Squad";
import { SquadOrchestrator } from "@/lib/core/SquadOrchestrator";
import { debugRouteError, debugRouteLog, isDebugRequest } from "@/lib/debug/server";

// Import tools to ensure they are registered
import { FileSystemReadTool, FileSystemWriteTool, FileSystemListTool } from "@/lib/tools/computer/file_system";
import { ShellExecuteTool } from "@/lib/tools/computer/shell";
import { WebSearchTool } from "@/lib/tools/web/search";

// Register Tools (Idempotent)
toolRegistry.register(FileSystemReadTool);
toolRegistry.register(FileSystemWriteTool);
toolRegistry.register(FileSystemListTool);
toolRegistry.register(ShellExecuteTool);
toolRegistry.register(WebSearchTool);

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

    // Backward compatibility for older clients.
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

export async function POST(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    try {
        debugRouteLog(debugEnabled, "api/chat", "POST request started");
        const apiKeys = await resolveApiKeys(req);
        const wantsSquadStream = req.headers.get("x-squad-stream") === "1";
        const body = await req.json();

        const {
            message,
            history = [],
            agentConfig,
            squadConfig,
            agents = [],
        }: {
            message?: string;
            history?: Message[];
            agentConfig?: AgentConfig;
            squadConfig?: SquadConfig;
            agents?: AgentConfig[];
        } = body;

        if (!message) {
            debugRouteLog(debugEnabled, "api/chat", "Rejected request: missing message");
            return NextResponse.json({ error: "Invalid Request: missing message" }, { status: 400 });
        }
        debugRouteLog(debugEnabled, "api/chat", "Parsed request payload", {
            hasSquadConfig: Boolean(squadConfig),
            historyCount: Array.isArray(history) ? history.length : 0,
            messageLength: message.length,
        });

        const tools = toolRegistry.getAll();
        const normalizedHistory = Array.isArray(history) ? history : [];
        const fullHistory: Message[] = [
            ...normalizedHistory,
            { role: "user", content: message, timestamp: Date.now(), id: "temp" },
        ];

        if (squadConfig) {
            if (!Array.isArray(agents) || agents.length === 0) {
                debugRouteLog(debugEnabled, "api/chat", "Rejected squad request: agents[] missing");
                return NextResponse.json({ error: "Invalid Request: squad mode requires agents[]" }, { status: 400 });
            }
            debugRouteLog(debugEnabled, "api/chat", "Running squad orchestrator", { agentCount: agents.length });
            const orchestrator = new SquadOrchestrator(agents, tools, apiKeys as AgentApiKeys);

            if (wantsSquadStream) {
                const encoder = new TextEncoder();
                const stream = new ReadableStream<Uint8Array>({
                    start: async (controller) => {
                        const send = (payload: Record<string, unknown>) => {
                            controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
                        };

                        try {
                            const result = await orchestrator.run(
                                squadConfig,
                                fullHistory,
                                message,
                                async (step) => {
                                    send({ type: "squad_step", step });
                                },
                            );
                            debugRouteLog(debugEnabled, "api/chat", "Squad stream completed", {
                                stepCount: Array.isArray(result.steps) ? result.steps.length : 0,
                                status: result.status,
                                response: result.response,
                            });
                            send({
                                type: "squad_complete",
                                response: result.response,
                                squadStatus: result.status,
                                squadSteps: result.steps,
                            });
                        } catch (error: unknown) {
                            debugRouteError(debugEnabled, "api/chat", "Squad stream failed", error);
                            send({
                                type: "error",
                                error: getErrorMessage(error),
                            });
                        } finally {
                            controller.close();
                        }
                    },
                });

                return new Response(stream, {
                    headers: {
                        "Content-Type": "application/x-ndjson; charset=utf-8",
                        "Cache-Control": "no-cache, no-transform",
                    },
                });
            }

            const result = await orchestrator.run(squadConfig, fullHistory, message);
            debugRouteLog(debugEnabled, "api/chat", "Squad response completed", {
                stepCount: Array.isArray(result.steps) ? result.steps.length : 0,
                status: result.status,
                response: result.response,
            });
            return NextResponse.json({
                response: result.response,
                squadStatus: result.status,
                squadSteps: result.steps,
            });
        }

        if (!agentConfig) {
            debugRouteLog(debugEnabled, "api/chat", "Rejected request: missing agentConfig or squadConfig");
            return NextResponse.json({ error: "Invalid Request: missing agentConfig or squadConfig" }, { status: 400 });
        }

        const agent = new Agent(agentConfig);
        const responseMsg = await agent.process(fullHistory, apiKeys, tools);
        debugRouteLog(debugEnabled, "api/chat", "Single-agent response completed", {
            agentName: agentConfig.name || "unknown",
            responseLength: responseMsg.content.length,
        });

        return NextResponse.json({ response: responseMsg.content });
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/chat", "Unhandled error in POST", error);
        console.error("Chat API Error:", error);
        const message = getErrorMessage(error);

        if (message.toLowerCase().includes("api key")) {
            return NextResponse.json({ error: message }, { status: 401 });
        }

        return NextResponse.json(
            { error: "Internal Server Error", details: message },
            { status: 500 },
        );
    }
}
