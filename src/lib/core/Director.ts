import { Agent, AgentConfig } from "./Agent";

interface DecomposedStep {
    id: string;
    description: string;
    assignedTo: string;
    dependency?: string;
}

export class DirectorAgent extends Agent {
    constructor(config: AgentConfig) {
        super(config);
        this.role = "Director/Orchestrator";
    }

    // The Director's main job is to take a high-level goal and split it into subtasks
    // for other agents.
    async decomposeTask(
        goal: string,
        availableAgents: Agent[],
        apiKeys: Record<string, string | null | undefined>,
    ): Promise<DecomposedStep[]> {
        const llm = this.getLLMClient(apiKeys);

        const systemPrompt = `You are the Director. Your goal is to break down a complex task into smaller steps and assign them to the most suitable agent from the following list:
    
    Available Agents:
    ${availableAgents.map(a => `- ${a.name} (Role: ${a.role}): ${a.systemPrompt.substring(0, 100)}...`).join("\n")}
    
    Output a JSON array of steps. Each step should have:
    - "id": string
    - "description": string
    - "assignedTo": string (Agent Name)
    - "dependency": string (ID of previous step, if any)
    
    Task: ${goal}
    
    Respond ONLY with the JSON array.`;

        const response = await llm.chat(
            [
                { role: "system", content: systemPrompt },
                { role: "user", content: goal }
            ],
            { max_tokens: 4096, temperature: 0.2 }
        );

        try {
            // Basic cleaning of response (remove code blocks if present)
            const cleanJson = response.content.replace(/```json/g, "").replace(/```/g, "").trim();
            return JSON.parse(cleanJson);
        } catch (e) {
            console.error("Failed to parse Director plan:", e);
            return []; // Fail gracefully
        }
    }
}
