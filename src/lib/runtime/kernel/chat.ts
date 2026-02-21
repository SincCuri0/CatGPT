import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { Agent, AgentApiKeys, AgentConfig } from "@/lib/core/Agent";
import { Message } from "@/lib/core/types";
import { SquadConfig } from "@/lib/core/Squad";
import { SquadOrchestrator } from "@/lib/core/SquadOrchestrator";
import { SubAgentRuntime } from "@/lib/core/runtime/SubAgentRuntime";
import { debugRouteError, debugRouteLog } from "@/lib/debug/server";
import { normalizeToolIds } from "@/lib/core/tooling/toolIds";
import { buildEvolvingAgentConfig } from "@/lib/evolution/engine";
import { preCompactionMemoryFlush, recordEvolutionTurn } from "@/lib/evolution/store";
import { acquireAgentRunLease, type AgentRunLease } from "@/lib/evolution/agentRunCoordinator";
import { ensureAgentWorkspace } from "@/lib/core/agentWorkspace";
import { resolveApiKeys } from "@/lib/api/resolveApiKeys";
import { RuntimeHookRegistry } from "@/lib/runtime";
import { getErrorMessage } from "@/lib/runtime/kernel/validation";
import { loadRuntimeTools } from "@/lib/runtime/kernel/tooling";
import {
    buildSecretValuesFromRecord,
    createSecretsRedactor,
    registerSecretsRedactionHooks,
} from "@/lib/runtime/services/secretsService";
import {
    registerTamagotchiPromptHooks,
    summarizeTamagotchiPromptContext,
} from "@/lib/runtime/services/tamagotchiRuntimeService";
import { normalizeEvolutionConfig } from "@/lib/evolution/types";
import { runtimeStateSyncService } from "@/lib/runtime/services/stateSyncService";
import { registerObservabilityHooks, runtimeObservabilityService } from "@/lib/runtime/services/observabilityService";

function collectRequestedToolIds(
    agentConfig: AgentConfig | undefined,
    squadConfig: SquadConfig | undefined,
    agents: AgentConfig[],
): Set<string> {
    const toolIds = new Set<string>();
    const memberIds = Array.isArray(squadConfig?.members)
        ? squadConfig.members
        : [];
    const relevantAgents = squadConfig
        ? agents.filter((candidate) => {
            const candidateId = (candidate.id || "").trim();
            return candidateId.length > 0 && memberIds.includes(candidateId);
        })
        : agents;
    const allAgents = agentConfig ? [agentConfig, ...relevantAgents] : [...relevantAgents];
    for (const candidate of allAgents) {
        for (const toolId of normalizeToolIds(candidate?.tools)) {
            toolIds.add(toolId);
        }
    }
    return toolIds;
}

function isLikelyImplementationRequest(message: string): boolean {
    return /(build|create|implement|develop|code|app|feature|edit|modify|refactor|fix|file|project)/i.test(message);
}

function hasFilesystemMcpTools(tools: Array<{ id: string; name: string; description: string }>): boolean {
    return tools.some((tool) => {
        const text = `${tool.id} ${tool.name} ${tool.description}`.toLowerCase();
        return /filesystem|file[_-]?system|directory|folder|path|read|write|edit|list/.test(text);
    });
}

function toSecretPlaceholderMap(apiKeys: Record<string, string | null>): Record<string, string> {
    const output: Record<string, string> = {};
    for (const [providerId, value] of Object.entries(apiKeys)) {
        if (typeof value !== "string" || value.trim().length === 0) continue;
        const normalizedProvider = providerId.trim().toUpperCase();
        output[`${normalizedProvider}_API_KEY`] = value.trim();
        output[providerId.trim()] = value.trim();
    }
    return output;
}

function runChannel(runId: string): string {
    return `run:${runId.toLowerCase()}`;
}

function agentChannel(agent: AgentConfig): string {
    const id = typeof agent.id === "string" && agent.id.trim().length > 0
        ? agent.id.trim().toLowerCase()
        : (agent.name || "unknown-agent").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    return `agent:${id}`;
}

function publishRunState(
    runId: string,
    agent: AgentConfig,
    type: string,
    payload: Record<string, unknown>,
    status = "active",
): void {
    const channelPayload = {
        runId,
        agentId: agent.id || null,
        agentName: agent.name || null,
        ...payload,
    };
    runtimeStateSyncService.publish(runChannel(runId), type, channelPayload, status);
    runtimeStateSyncService.publish(agentChannel(agent), type, channelPayload, status);
}

export async function executeChatPost(req: NextRequest, debugEnabled: boolean): Promise<Response> {
    let agentRunLease: AgentRunLease | null = null;
    let activeRunId: string | null = null;
    let activeAgent: AgentConfig | null = null;
    let activeRuntimeHookRegistry: RuntimeHookRegistry | null = null;
    try {
        debugRouteLog(debugEnabled, "api/chat", "POST request started");
        const apiKeys = await resolveApiKeys(req);
        const secretValues = buildSecretValuesFromRecord(apiKeys);
        const secretPlaceholderMap = toSecretPlaceholderMap(apiKeys);
        const redactor = createSecretsRedactor(secretValues);
        const wantsSquadStream = req.headers.get("x-squad-stream") === "1";
        const body = await req.json();

        const {
            message,
            history = [],
            agentConfig,
            squadConfig,
            agents = [],
            toolAccessGranted = false,
        }: {
            message?: string;
            history?: Message[];
            agentConfig?: AgentConfig;
            squadConfig?: SquadConfig;
            agents?: AgentConfig[];
            toolAccessGranted?: boolean;
        } = body;

        if (!message) {
            debugRouteLog(debugEnabled, "api/chat", "Rejected request: missing message");
            return NextResponse.json({ error: "Invalid Request: missing message" }, { status: 400 });
        }
        debugRouteLog(debugEnabled, "api/chat", "Parsed request payload", {
            hasSquadConfig: Boolean(squadConfig),
            historyCount: Array.isArray(history) ? history.length : 0,
            messageLength: message.length,
            toolAccessGranted: toolAccessGranted === true,
        });

        const requestedToolIds = collectRequestedToolIds(agentConfig, squadConfig, Array.isArray(agents) ? agents : []);
        const requiresMcpTools = requestedToolIds.has("mcp_all");
        const likelyImplementationRequest = requiresMcpTools && isLikelyImplementationRequest(message);

        const toolLoad = await loadRuntimeTools(debugEnabled, "api/chat");
        const tools = toolLoad.tools;
        const mcpTools = toolLoad.mcpTools;
        const mcpLoadError = toolLoad.mcpLoadError;

        if (requiresMcpTools) {
            if (mcpLoadError || mcpTools.length === 0) {
                const details = mcpLoadError || "No MCP tools were discovered from enabled services.";
                return NextResponse.json(
                    {
                        error: "This run requires MCP tools (`mcp_all`), but MCP services are unavailable.",
                        details,
                    },
                    { status: 503 },
                );
            }

            if (likelyImplementationRequest && !hasFilesystemMcpTools(mcpTools)) {
                return NextResponse.json(
                    {
                        error: "This run appears to require filesystem editing, but no filesystem MCP tools are available.",
                        details: "Enable a filesystem MCP service (for example `@modelcontextprotocol/server-filesystem`) and retry.",
                    },
                    { status: 503 },
                );
            }
        }

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
            const orchestrator = new SquadOrchestrator(
                agents,
                tools,
                apiKeys as AgentApiKeys,
                (squadMessage, data) => debugRouteLog(debugEnabled, "api/chat", squadMessage, data),
            );

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
                                { toolAccessGranted: toolAccessGranted === true },
                            );
                            debugRouteLog(debugEnabled, "api/chat", "Squad stream completed", {
                                stepCount: Array.isArray(result.steps) ? result.steps.length : 0,
                                status: result.status,
                                response: result.response,
                            });
                            send({
                                type: "squad_complete",
                                response: redactor.maskText(result.response),
                                squadStatus: result.status,
                                squadSteps: result.steps,
                            });
                        } catch (error: unknown) {
                            debugRouteError(debugEnabled, "api/chat", "Squad stream failed", error);
                            send({
                                type: "error",
                                error: redactor.maskText(getErrorMessage(error)),
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

            const result = await orchestrator.run(
                squadConfig,
                fullHistory,
                message,
                undefined,
                { toolAccessGranted: toolAccessGranted === true },
            );
            debugRouteLog(debugEnabled, "api/chat", "Squad response completed", {
                stepCount: Array.isArray(result.steps) ? result.steps.length : 0,
                status: result.status,
                response: result.response,
            });
            return NextResponse.json({
                response: redactor.maskText(result.response),
                squadStatus: result.status,
                squadSteps: result.steps,
            });
        }

        if (!agentConfig) {
            debugRouteLog(debugEnabled, "api/chat", "Rejected request: missing agentConfig or squadConfig");
            return NextResponse.json({ error: "Invalid Request: missing agentConfig or squadConfig" }, { status: 400 });
        }

        agentRunLease = await acquireAgentRunLease(agentConfig, "user", {
            timeoutMs: 15_000,
            pollIntervalMs: 200,
        });
        if (!agentRunLease) {
            debugRouteLog(debugEnabled, "api/chat", "Agent run lock unavailable", {
                agentId: agentConfig.id || "(missing)",
                agentName: agentConfig.name || "(missing)",
            });
            return NextResponse.json(
                {
                    error: "Agent is busy with another run. Try again in a few seconds.",
                    details: "Another user/autonomy run is currently active for this agent.",
                },
                { status: 409 },
            );
        }

        const evolvedAgentBuild = await buildEvolvingAgentConfig(agentConfig);
        const runtimeAgentConfig = evolvedAgentBuild.config;
        const agentWorkspace = await ensureAgentWorkspace(runtimeAgentConfig);
        const evolutionConfig = evolvedAgentBuild.evolution;
        const preCompactionFlushApplied = evolutionConfig.enabled
            ? await preCompactionMemoryFlush(agentConfig, evolutionConfig, fullHistory)
            : false;

        const agent = new Agent(runtimeAgentConfig);
        const runId = uuidv4();
        activeRunId = runId;
        activeAgent = runtimeAgentConfig;
        const runtimeHookRegistry = new RuntimeHookRegistry();
        activeRuntimeHookRegistry = runtimeHookRegistry;
        publishRunState(runId, runtimeAgentConfig, "run_started", {
            toolAccessGranted: toolAccessGranted === true,
            evolutionEnabled: evolutionConfig.enabled,
        }, "running");
        registerSecretsRedactionHooks(runtimeHookRegistry, redactor);
        registerTamagotchiPromptHooks({
            registry: runtimeHookRegistry,
            agent: agentConfig,
            evolution: normalizeEvolutionConfig(evolutionConfig),
            requestedToolIds: [...requestedToolIds],
        });
        registerObservabilityHooks(runtimeHookRegistry, runtimeObservabilityService);
        runtimeHookRegistry.register("prompt_before", (event) => {
            publishRunState(runId, runtimeAgentConfig, "prompt_prepared", {
                contextMessageCount: event.contextMessages.length,
                userPromptLength: event.userPrompt.length,
            }, "running");
        }, { id: "state-sync-prompt-before", priority: 55 });
        runtimeHookRegistry.register("tool_before", (event) => {
            publishRunState(runId, runtimeAgentConfig, "tool_started", {
                toolId: event.toolId,
                toolName: event.toolName,
            }, "running");
        }, { id: "state-sync-tool-before", priority: 55 });
        runtimeHookRegistry.register("tool_after", (event) => {
            const result = event.result as { ok?: unknown } | null;
            publishRunState(runId, runtimeAgentConfig, "tool_completed", {
                toolId: event.toolId,
                toolName: event.toolName,
                durationMs: event.durationMs,
                ok: typeof result?.ok === "boolean" ? result.ok : null,
            }, "running");
        }, { id: "state-sync-tool-after", priority: 55 });
        runtimeHookRegistry.register("run_end", (event) => {
            publishRunState(runId, runtimeAgentConfig, "run_completed", {
                durationMs: event.durationMs,
                outputLength: (event.output || "").length,
            }, event.status);
        }, { id: "state-sync-run-end", priority: 55 });
        if (debugEnabled) {
            runtimeHookRegistry.register("prompt_before", (event) => {
                debugRouteLog(debugEnabled, "api/chat", "runtime_hook.prompt_before", {
                    runId: event.runId,
                    agentId: event.agentId,
                    contextMessageCount: event.contextMessages.length,
                    userPromptLength: event.userPrompt.length,
                });
            });
            runtimeHookRegistry.register("tool_before", (event) => {
                debugRouteLog(debugEnabled, "api/chat", "runtime_hook.tool_before", {
                    runId: event.runId,
                    toolId: event.toolId,
                    toolName: event.toolName,
                });
            });
            runtimeHookRegistry.register("tool_after", (event) => {
                debugRouteLog(debugEnabled, "api/chat", "runtime_hook.tool_after", {
                    runId: event.runId,
                    toolId: event.toolId,
                    toolName: event.toolName,
                    durationMs: event.durationMs,
                    ok: typeof event.result === "object" && event.result !== null && "ok" in event.result
                        ? (event.result as { ok?: unknown }).ok
                        : undefined,
                });
            });
            runtimeHookRegistry.register("run_end", (event) => {
                debugRouteLog(debugEnabled, "api/chat", "runtime_hook.run_end", {
                    runId: event.runId,
                    status: event.status,
                    durationMs: event.durationMs,
                    outputLength: (event.output || "").length,
                });
            });
        }
        if (debugEnabled && evolutionConfig.enabled) {
            const tamagotchiContext = await summarizeTamagotchiPromptContext(
                agentConfig,
                message,
                [...requestedToolIds],
            );
            debugRouteLog(debugEnabled, "api/chat", "tamagotchi_prompt_context", tamagotchiContext);
        }
        const runtimeAgents = [runtimeAgentConfig, ...agents].filter((candidate, index, source) => (
            source.findIndex((entry) => entry.id === candidate.id && entry.name === candidate.name) === index
        ));
        const subAgentRuntime = new SubAgentRuntime({
            availableAgents: runtimeAgents,
            availableTools: tools,
            apiKeys: apiKeys as AgentApiKeys,
            currentAgentId: runtimeAgentConfig.id,
            currentAgentName: runtimeAgentConfig.name,
            parentRunId: runId,
            parentExecutionContext: {
                runId,
                toolAccessMode: runtimeAgentConfig.accessMode === "full_access" ? "full_access" : "ask_always",
                toolAccessGranted: toolAccessGranted === true,
                agentWorkspaceRoot: agentWorkspace.rootAbsolutePath,
                agentWorkspaceRootRelative: agentWorkspace.rootRelativePath,
                agentWorkspaceArtifactsDir: agentWorkspace.artifactsAbsolutePath,
                agentWorkspaceArtifactsDirRelative: agentWorkspace.artifactsRelativePath,
                runtimeHookRegistry,
                secretValues: secretPlaceholderMap,
            },
        });

        const responseMsg = await agent.process(fullHistory, apiKeys, tools, {
            runId,
            toolAccessMode: runtimeAgentConfig.accessMode === "full_access" ? "full_access" : "ask_always",
            toolAccessGranted: toolAccessGranted === true,
            agentWorkspaceRoot: agentWorkspace.rootAbsolutePath,
            agentWorkspaceRootRelative: agentWorkspace.rootRelativePath,
            agentWorkspaceArtifactsDir: agentWorkspace.artifactsAbsolutePath,
            agentWorkspaceArtifactsDirRelative: agentWorkspace.artifactsRelativePath,
            runtimeHookRegistry,
            secretValues: secretPlaceholderMap,
            ...subAgentRuntime.createExecutionContext(),
        });

        const evolutionStatus = evolutionConfig.enabled
            ? await recordEvolutionTurn({
                agent: agentConfig,
                config: evolutionConfig,
                runType: "user",
                prompt: message,
                response: responseMsg.content,
            })
            : null;
        debugRouteLog(debugEnabled, "api/chat", "Single-agent response completed", {
            agentName: runtimeAgentConfig.name || "unknown",
            responseLength: responseMsg.content.length,
            runId,
            evolutionEnabled: evolutionConfig.enabled,
            preCompactionFlushApplied,
        });

        return NextResponse.json({
            response: redactor.maskText(responseMsg.content),
            runId,
            ...(evolutionStatus ? { evolution: evolutionStatus } : {}),
        });
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/chat", "Unhandled error in POST", error);
        console.error("Chat API Error:", error);
        const message = getErrorMessage(error);
        let redactedMessage = message.replace(/(api[_-]?key|token|secret)[^.,;:]*/gi, "$1 [REDACTED]");
        if (activeRuntimeHookRegistry && activeRunId) {
            const errorEvent = {
                runId: activeRunId,
                agentId: activeAgent?.id,
                timestamp: Date.now(),
                error,
                formattedMessage: redactedMessage,
            };
            await activeRuntimeHookRegistry.emit("error_format", errorEvent);
            if (typeof errorEvent.formattedMessage === "string" && errorEvent.formattedMessage.trim().length > 0) {
                redactedMessage = errorEvent.formattedMessage;
            }
        }
        if (activeRunId && activeAgent) {
            publishRunState(activeRunId, activeAgent, "run_failed", {
                error: redactedMessage,
            }, "failed");
        }

        if (redactedMessage.toLowerCase().includes("api key")) {
            return NextResponse.json({ error: redactedMessage }, { status: 401 });
        }

        return NextResponse.json(
            { error: "Internal Server Error", details: redactedMessage },
            { status: 500 },
        );
    } finally {
        agentRunLease?.release();
    }
}
