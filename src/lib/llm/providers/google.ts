import { GoogleGenerativeAI } from "@google/generative-ai";
import { LLMChatOptions, LLMClient, LLMMessage, LLMResponse } from "../types";
import { LLMProvider, ProviderConfig } from "../providerTypes";

const GOOGLE_MODELS = [
    { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro", description: "Mid-size multimodal" },
    { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash", description: "Fast & cost-efficient" },
    { id: "gemini-pro", label: "Gemini 1.0 Pro", description: "Legacy Pro" },
];

class GoogleClient implements LLMClient {
    private client: GoogleGenerativeAI;
    private model: string;

    constructor(apiKey: string, model: string = "gemini-1.5-pro") {
        this.client = new GoogleGenerativeAI(apiKey);
        this.model = model;
    }

    async chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMResponse> {
        try {
            const model = this.client.getGenerativeModel({ model: this.model });

            // Convert messages to Gemini format
            const chatHistory = messages.map(m => ({
                role: m.role === "assistant" ? "model" : "user",
                parts: [{ text: m.content }],
            }));

            // Gemini handles system instruction via model config or separate param
            // For simple chat, we can just start a chat session.
            // Note: System prompt is better handled by 'systemInstruction' in newer SDKs, 
            // but for simplicity in this standard chat loop we'll try to prepend or use it if available.

            const systemMessage = messages.find(m => m.role === "system");
            const history = messages.filter(m => m.role !== "system").map(m => ({
                role: m.role === "assistant" ? "model" : "user",
                parts: [{ text: m.content }],
            }));

            // Currently, simple chat with history:
            // We use the last message as the prompt and the rest as history.
            // However, the `chat` method expects a full array in our interface.

            // To properly use Gemini chat, we should start a chat with history.
            // Let's grab the last user message.
            const lastMsg = history.pop();
            if (!lastMsg) throw new Error("No messages to send");

            const chat = model.startChat({
                history: history,
                generationConfig: {
                    maxOutputTokens: options?.max_tokens,
                    temperature: options?.temperature,
                },
                systemInstruction: systemMessage ? systemMessage.content : undefined,
            });

            const result = await chat.sendMessage(lastMsg.parts[0].text);
            const response = result.response;
            const text = response.text();

            return {
                content: text,
                usage: {
                    total_tokens: 0, // Gemini doesn't always return simple token counts in the same way
                },
            };
        } catch (error) {
            console.error("Google Gemini API Error:", error);
            throw error;
        }
    }
}

export class GoogleProvider extends LLMProvider {
    get config(): ProviderConfig {
        return {
            id: "google",
            name: "Google Gemini",
            description: "Multimodal models from Google",
            defaultModel: "gemini-1.5-pro",
            models: GOOGLE_MODELS,
            requiresApiKey: true,
            apiKeyLink: "https://aistudio.google.com/app/apikey",
        };
    }

    createClient(apiKey: string, model?: string): LLMClient {
        return new GoogleClient(apiKey, model || this.config.defaultModel);
    }
}
