import type { AgentConfig } from "@/lib/core/Agent";
import { normalizeToolIds } from "@/lib/core/tooling/toolIds";
import type { NormalizedAgentEvolutionConfig } from "@/lib/evolution/types";
import type { RuntimeHookRegistry } from "@/lib/runtime/hooks/registry";
import {
    buildMemoryRecallPrompt,
    recallAgentMemories,
} from "@/lib/runtime/services/memoryRecallService";
import {
    buildRuntimeSkillsPrompt,
    loadRuntimeSkills,
    selectRelevantRuntimeSkills,
} from "@/lib/runtime/services/skillsRuntimeService";

interface TamagotchiHookRuntimeResult {
    memoryCount: number;
    skillCount: number;
}

export interface RegisterTamagotchiPromptHooksOptions {
    registry: RuntimeHookRegistry;
    agent: AgentConfig;
    evolution: NormalizedAgentEvolutionConfig;
    requestedToolIds?: string[];
}

export function isTamagotchiLearningEnabled(evolution: NormalizedAgentEvolutionConfig): boolean {
    return evolution.enabled && (evolution.memoryEnabled || evolution.skillSnapshotsEnabled);
}

export function registerTamagotchiPromptHooks(options: RegisterTamagotchiPromptHooksOptions): void {
    const { registry, agent, evolution } = options;
    if (!isTamagotchiLearningEnabled(evolution)) return;

    const activeToolIds = normalizeToolIds(options.requestedToolIds || agent.tools || []);

    registry.register("prompt_before", async (event) => {
        if (!event.userPrompt || !event.userPrompt.trim()) return;
        const appendices: string[] = [];

        if (evolution.memoryEnabled) {
            const recalled = await recallAgentMemories(agent, event.userPrompt, {
                limit: 8,
                minScore: 0.1,
            });
            const memoryPrompt = buildMemoryRecallPrompt(recalled);
            if (memoryPrompt) {
                appendices.push(memoryPrompt);
            }
        }

        if (evolution.skillSnapshotsEnabled) {
            const loadedSkills = await loadRuntimeSkills(agent);
            const selectedSkills = selectRelevantRuntimeSkills(
                loadedSkills,
                event.userPrompt,
                activeToolIds,
                { limit: 4, minScore: 0.05 },
            );
            const skillsPrompt = buildRuntimeSkillsPrompt(selectedSkills);
            if (skillsPrompt) {
                appendices.push(skillsPrompt);
            }
        }

        if (appendices.length > 0) {
            const existing = Array.isArray(event.systemPromptAppendices) ? event.systemPromptAppendices : [];
            event.systemPromptAppendices = [...existing, ...appendices];
        }
    }, { id: "tamagotchi-prompt-hooks", priority: 40 });
}

export async function summarizeTamagotchiPromptContext(
    agent: AgentConfig,
    userPrompt: string,
    requestedToolIds: string[],
): Promise<TamagotchiHookRuntimeResult> {
    const [memories, skills] = await Promise.all([
        recallAgentMemories(agent, userPrompt, { limit: 8, minScore: 0.1 }),
        loadRuntimeSkills(agent),
    ]);
    const selected = selectRelevantRuntimeSkills(skills, userPrompt, normalizeToolIds(requestedToolIds), {
        limit: 4,
        minScore: 0.05,
    });
    return {
        memoryCount: memories.length,
        skillCount: selected.length,
    };
}
