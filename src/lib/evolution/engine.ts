import { v4 as uuidv4 } from "uuid";
import type { AgentApiKeys, AgentConfig } from "@/lib/core/Agent";
import { Agent } from "@/lib/core/Agent";
import { SubAgentRuntime } from "@/lib/core/runtime/SubAgentRuntime";
import { ensureAgentWorkspace } from "@/lib/core/agentWorkspace";
import type { Message, Tool } from "@/lib/core/types";
import { buildEvolutionSystemContext, getEvolutionStatus, recordEvolutionTurn } from "@/lib/evolution/store";
import type { EvolutionRunType, EvolutionStatus, NormalizedAgentEvolutionConfig } from "@/lib/evolution/types";
import { normalizeEvolutionConfig } from "@/lib/evolution/types";
import { RuntimeHookRegistry } from "@/lib/runtime";
import { registerTamagotchiPromptHooks } from "@/lib/runtime/services/tamagotchiRuntimeService";
import {
    buildSecretValuesFromRecord,
    createSecretsRedactor,
    registerSecretsRedactionHooks,
} from "@/lib/runtime/services/secretsService";
import { runtimeStateSyncService } from "@/lib/runtime/services/stateSyncService";
import { registerObservabilityHooks, runtimeObservabilityService } from "@/lib/runtime/services/observabilityService";

interface BuildEvolvingAgentConfigResult {
    config: AgentConfig;
    evolution: NormalizedAgentEvolutionConfig;
}

interface RunEvolutionTurnOptions {
    agentConfig: AgentConfig;
    agents: AgentConfig[];
    tools: Tool[];
    apiKeys: AgentApiKeys;
    prompt: string;
    runType: EvolutionRunType;
    toolAccessGranted?: boolean;
}

interface RunEvolutionTurnResult {
    runId: string;
    response: string;
    status: EvolutionStatus;
}

function appendEvolutionPrompt(basePrompt: string, extension: string): string {
    const normalizedBase = (basePrompt || "").trim();
    const normalizedExtension = extension.trim();
    if (!normalizedExtension) return normalizedBase;
    if (!normalizedBase) return normalizedExtension;
    return `${normalizedBase}\n\n${normalizedExtension}`;
}

function dedupeAgentList(agents: AgentConfig[]): AgentConfig[] {
    const output: AgentConfig[] = [];
    for (const candidate of agents) {
        const exists = output.some((entry) => entry.id === candidate.id && entry.name === candidate.name);
        if (!exists) output.push(candidate);
    }
    return output;
}

function toApiKeyRecord(apiKeys: AgentApiKeys): Record<string, string | null> {
    if (!apiKeys) return {};
    if (typeof apiKeys === "string") {
        return { groq: apiKeys };
    }
    const output: Record<string, string | null> = {};
    for (const [providerId, value] of Object.entries(apiKeys)) {
        output[providerId] = typeof value === "string" ? value : null;
    }
    return output;
}

function toSecretPlaceholderMap(apiKeys: Record<string, string | null>): Record<string, string> {
    const output: Record<string, string> = {};
    for (const [providerId, value] of Object.entries(apiKeys)) {
        if (typeof value !== "string" || value.trim().length === 0) continue;
        const normalizedProvider = providerId.trim().toUpperCase();
        output[providerId] = value.trim();
        output[`${normalizedProvider}_API_KEY`] = value.trim();
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

export async function buildEvolvingAgentConfig(agentConfig: AgentConfig): Promise<BuildEvolvingAgentConfigResult> {
    const evolution = normalizeEvolutionConfig(agentConfig.evolution);
    if (!evolution.enabled) {
        return {
            config: agentConfig,
            evolution,
        };
    }

    const evolutionContext = await buildEvolutionSystemContext(agentConfig, evolution);
    return {
        config: {
            ...agentConfig,
            systemPrompt: appendEvolutionPrompt(agentConfig.systemPrompt || "", evolutionContext),
        },
        evolution,
    };
}

export async function runEvolutionTurn(options: RunEvolutionTurnOptions): Promise<RunEvolutionTurnResult> {
    const built = await buildEvolvingAgentConfig(options.agentConfig);
    if (!built.evolution.enabled) {
        throw new Error("Evolution mode is not enabled for this agent.");
    }

    const runId = uuidv4();
    const apiKeyRecord = toApiKeyRecord(options.apiKeys);
    const redactor = createSecretsRedactor(buildSecretValuesFromRecord(apiKeyRecord));
    const secretPlaceholderMap = toSecretPlaceholderMap(apiKeyRecord);
    const runtimeAgents = dedupeAgentList([built.config, ...options.agents]);
    const agentWorkspace = await ensureAgentWorkspace(built.config);
    const history: Message[] = [{
        id: "evolution_prompt",
        role: "user",
        content: options.prompt,
        timestamp: Date.now(),
    }];
    const runtimeHookRegistry = new RuntimeHookRegistry();
    registerSecretsRedactionHooks(runtimeHookRegistry, redactor);
    registerTamagotchiPromptHooks({
        registry: runtimeHookRegistry,
        agent: options.agentConfig,
        evolution: built.evolution,
        requestedToolIds: options.agentConfig.tools,
    });
    registerObservabilityHooks(runtimeHookRegistry, runtimeObservabilityService);
    runtimeStateSyncService.publish(runChannel(runId), "evolution_run_started", {
        runId,
        runType: options.runType,
        agentId: options.agentConfig.id || null,
        agentName: options.agentConfig.name || null,
    }, "running");
    runtimeStateSyncService.publish(agentChannel(options.agentConfig), "evolution_run_started", {
        runId,
        runType: options.runType,
    }, "running");

    const subAgentRuntime = new SubAgentRuntime({
        availableAgents: runtimeAgents,
        availableTools: options.tools,
        apiKeys: options.apiKeys,
        currentAgentId: built.config.id,
        currentAgentName: built.config.name,
        parentRunId: runId,
        parentExecutionContext: {
            runId,
            toolAccessMode: built.config.accessMode === "full_access" ? "full_access" : "ask_always",
            toolAccessGranted: options.toolAccessGranted === true,
            agentWorkspaceRoot: agentWorkspace.rootAbsolutePath,
            agentWorkspaceRootRelative: agentWorkspace.rootRelativePath,
            agentWorkspaceArtifactsDir: agentWorkspace.artifactsAbsolutePath,
            agentWorkspaceArtifactsDirRelative: agentWorkspace.artifactsRelativePath,
            runtimeHookRegistry,
            secretValues: secretPlaceholderMap,
        },
    });

    const agent = new Agent(built.config);
    try {
        const responseMsg = await agent.process(history, options.apiKeys, options.tools, {
            runId,
            toolAccessMode: built.config.accessMode === "full_access" ? "full_access" : "ask_always",
            toolAccessGranted: options.toolAccessGranted === true,
            agentWorkspaceRoot: agentWorkspace.rootAbsolutePath,
            agentWorkspaceRootRelative: agentWorkspace.rootRelativePath,
            agentWorkspaceArtifactsDir: agentWorkspace.artifactsAbsolutePath,
            agentWorkspaceArtifactsDirRelative: agentWorkspace.artifactsRelativePath,
            runtimeHookRegistry,
            secretValues: secretPlaceholderMap,
            ...subAgentRuntime.createExecutionContext(),
        });

        const status = await recordEvolutionTurn({
            agent: options.agentConfig,
            config: built.evolution,
            runType: options.runType,
            prompt: options.prompt,
            response: responseMsg.content,
        });
        runtimeStateSyncService.publish(runChannel(runId), "evolution_run_completed", {
            runId,
            responseLength: responseMsg.content.length,
        }, "completed");
        runtimeStateSyncService.publish(agentChannel(options.agentConfig), "evolution_run_completed", {
            runId,
            responseLength: responseMsg.content.length,
        }, "completed");

        return {
            runId,
            response: redactor.maskText(responseMsg.content),
            status,
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        runtimeStateSyncService.publish(runChannel(runId), "evolution_run_failed", {
            runId,
            error: message,
        }, "failed");
        runtimeStateSyncService.publish(agentChannel(options.agentConfig), "evolution_run_failed", {
            runId,
            error: message,
        }, "failed");
        throw error;
    }
}

export async function getEvolutionStatusForAgent(agentConfig: AgentConfig): Promise<EvolutionStatus> {
    return getEvolutionStatus(agentConfig);
}
