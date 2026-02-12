import { v4 as uuidv4 } from "uuid";
import { Message, Tool } from "./types";
import { createLLMClient } from "../llm/groq";

export type AgentStyle = "assistant" | "character" | "expert" | "custom";

export interface AgentConfig {
    id?: string;
    name: string;
    role: string;
    description?: string;
    style?: AgentStyle;
    systemPrompt: string;
    voiceId?: string; // Edge TTS voice ID
    model?: string;
    tools?: string[]; // IDs of enabled tools
}

export class Agent {
    public id: string;
    public name: string;
    public role: string;
    public systemPrompt: string;
    public voiceId: string;
    public model: string;
    public tools: string[]; // List of tool IDs

    constructor(config: AgentConfig) {
        this.id = config.id || uuidv4();
        this.name = config.name;
        this.role = config.role;
        this.systemPrompt = config.systemPrompt;
        this.voiceId = config.voiceId || "en-US-ChristopherNeural"; // Default male voice
        this.model = config.model || "llama-3.3-70b-versatile";
        this.tools = config.tools || [];
    }

    async process(history: Message[], apiKey: string | null, availableTools: Tool[] = []): Promise<Message> {
        if (!apiKey) {
            throw new Error("API Key missing (Internal Check Failed)");
        }
        const llm = createLLMClient(apiKey, "groq");

        // Filter tools enabled for this agent
        const enabledTools = availableTools.filter(t => this.tools.includes(t.id) || this.tools.includes(t.name));

        // Prepare System Message
        const systemMessage: Message = {
            id: uuidv4(),
            role: "system",
            content: `You are ${this.name}, a ${this.role}.
      
      Personality/Instructions:
      ${this.systemPrompt}
      
      Start your response directly. Do not prefix with "System:" or "Agent:".`,
            timestamp: Date.now()
        };

        // Convert to LLM format
        const llmMessages = [
            { role: "system" as const, content: systemMessage.content },
            ...history.map(m => ({ role: m.role as "user" | "assistant", content: m.content }))
        ];

        // Tool Execution Loop (Simple ReAct/Function Calling Pattern)
        // We allow up to 5 turns to prevent infinite loops
        let currentHistory = [...llmMessages];

        for (let turn = 0; turn < 5; turn++) {
            // 1. Call LLM
            // We need to adhere to Groq's tool format if using native tools, or system prompt if using ReAct.
            // For simplicity and compatibility with Llama 3 on Groq, we'll try native tools if supported, 
            // but the current GroqClient wrapper needs to expose that.
            // Let's assume standard chat for now with System Prompt instructions for tools.

            // MVP: We inject tool definitions into system prompt because strict tool/function calling 
            // implementation varies by provider and we want a generic "local" feel.
            // But for "Smart" agents, we should use native tools eventually.

            // Let's stick to a robust System Prompt approach for the MVP to ensure it works across models.

            // Update System Message with Tools if not already done (we construct it fresh each time? No, we used local var)
            // We'll append tool schemas to the system prompt.
            const toolsDescription = enabledTools.map(t =>
                `- Tool: ${t.name} (ID: ${t.id})\n  Description: ${t.description}\n  Params: ${JSON.stringify(t.parameters)}`
            ).join("\n\n");

            if (enabledTools.length > 0 && turn === 0) {
                currentHistory[0].content += `\n\n## AVAILABLE TOOLS\nYou have access to the following tools. To use one, reply ONLY with a JSON block:
            \`\`\`json
            { "tool": "tool_id", "args": { ... } }
            \`\`\`
            
            Tools List:
            ${toolsDescription}
            
            If no tool is needed, just respond normally.`;
            }

            const response = await llm.chat(currentHistory, { max_tokens: 4096 });
            const assistantContent = response.content;

            // 2. Check for Tool Call
            // Try specific markdown format first
            let toolBlockRegex = /```json\s*({[\s\S]*?"tool"[\s\S]*?})\s*```/;
            let match = assistantContent.match(toolBlockRegex);

            // Fallback: Try without markdown or with different markdown
            if (!match) {
                // regex to find a JSON-like object containing "tool": "name" at the start
                const looseRegex = /^\s*({[\s\S]*?"tool"[\s\S]*?})\s*$/;
                match = assistantContent.match(looseRegex);
            }

            // Fallback 2: Look for it anywhere if it looks like a tool call
            if (!match) {
                const embeddedRegex = /({[\s\S]*?"tool"\s*:\s*"[^"]+"[\s\S]*?})/;
                match = assistantContent.match(embeddedRegex);
            }

            if (match) {
                try {
                    // We found a tool call
                    const toolCall = JSON.parse(match[1]);
                    const tool = enabledTools.find(t => t.id === toolCall.tool || t.name === toolCall.tool);

                    if (tool) {
                        // Execute Tool
                        // console.log(`[Agent ${this.name}] Executing ${tool.name}`, toolCall.args);

                        // Add Assistant's "Thought" (Tool Call) to history
                        currentHistory.push({ role: "assistant", content: assistantContent });

                        const result = await tool.execute(toolCall.args);

                        // Add Tool Result to history
                        currentHistory.push({
                            role: "user", // Represent tool output as user message or system message for the model to see
                            content: `[Tool Result for ${tool.name}]:\n${result}`
                        });

                        // Loop continues to let Model interpret result
                        continue;
                    } else {
                        currentHistory.push({ role: "assistant", content: assistantContent });
                        currentHistory.push({ role: "system", content: `Error: Tool '${toolCall.tool}' not found.` });
                    }
                } catch (e) {
                    // JSON parse error or execution error
                    currentHistory.push({ role: "assistant", content: assistantContent });
                    currentHistory.push({ role: "system", content: `Error parsing tool call: ${e}` });
                }
            } else {
                // No tool call, just a response. Return it.
                return {
                    id: uuidv4(),
                    role: "assistant",
                    name: this.name,
                    content: assistantContent,
                    timestamp: Date.now()
                };
            }
        }

        return {
            id: uuidv4(),
            role: "assistant",
            name: this.name,
            content: "Error: Task limit exceeded (too many tool calls).",
            timestamp: Date.now()
        };
    }
}
