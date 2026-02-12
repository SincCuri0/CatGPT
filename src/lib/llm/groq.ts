import Groq from "groq-sdk";
import { LLMClient, LLMMessage, LLMResponse } from "./types";

export class GroqClient implements LLMClient {
    private client: Groq;
    private model: string;

    constructor(apiKey: string, model: string = "llama-3.3-70b-versatile") {
        if (!apiKey) throw new Error("API Key is required for GroqClient");
        this.client = new Groq({ apiKey, dangerouslyAllowBrowser: true }); // We allow browser because keys are local-only
        this.model = model;
    }

    async chat(messages: LLMMessage[], options?: { temperature?: number; max_tokens?: number }): Promise<LLMResponse> {
        try {
            const completion = await this.client.chat.completions.create({
                messages,
                model: this.model,
                temperature: options?.temperature ?? 0.7,
                max_tokens: options?.max_tokens ?? 4096,
            });

            return {
                content: completion.choices[0]?.message?.content || "",
                usage: {
                    total_tokens: completion.usage?.total_tokens || 0,
                },
            };
        } catch (error) {
            console.error("Groq API Error:", error);
            throw error;
        }
    }
}

export function createLLMClient(apiKey: string, provider: "groq" = "groq"): LLMClient {
    // Extensible for other providers later
    return new GroqClient(apiKey);
}
