import { GoogleGenerativeAI } from "@google/generative-ai";
import { LLMChatOptions, LLMClient, LLMMessage, LLMResponse } from "../types";
import { LLMProvider, ProviderConfig } from "../providerTypes";
import { supportsGoogleThinking } from "../modelCatalog";

const GOOGLE_MODELS = [
    { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro", description: "Mid-size multimodal" },
    { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash", description: "Fast & cost-efficient" },
    { id: "gemini-pro", label: "Gemini 1.0 Pro", description: "Legacy Pro" },
];

const GOOGLE_THINKING_BUDGET_BY_EFFORT = {
    low: 256,
    medium: 1024,
    high: 4096,
} as const;

type JsonSchemaRecord = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toGoogleSchema(rawSchema: unknown): JsonSchemaRecord | undefined {
    if (!isRecord(rawSchema)) return undefined;

    const type = typeof rawSchema.type === "string" ? rawSchema.type : undefined;
    const schema: JsonSchemaRecord = {};

    if (type) {
        schema.type = type;
    }
    if (typeof rawSchema.description === "string") {
        schema.description = rawSchema.description;
    }

    const enumValues = Array.isArray(rawSchema.enum) ? rawSchema.enum : undefined;
    if (enumValues && enumValues.length > 0) {
        schema.enum = enumValues;
        if (type === "string") {
            schema.format = "enum";
        }
    }

    if (type === "object") {
        const rawProperties = isRecord(rawSchema.properties) ? rawSchema.properties : {};
        const convertedProperties: Record<string, unknown> = {};
        for (const [key, nestedRawSchema] of Object.entries(rawProperties)) {
            const converted = toGoogleSchema(nestedRawSchema);
            if (converted) {
                convertedProperties[key] = converted;
            }
        }
        schema.properties = convertedProperties;
        if (Array.isArray(rawSchema.required)) {
            schema.required = rawSchema.required.filter((entry): entry is string => typeof entry === "string");
        }
    } else if (type === "array") {
        const convertedItems = toGoogleSchema(rawSchema.items);
        if (convertedItems) {
            schema.items = convertedItems;
        } else {
            schema.items = { type: "string" };
        }
    }

    return schema;
}

class GoogleClient implements LLMClient {
    public readonly supportsNativeToolCalling = true;
    private client: GoogleGenerativeAI;
    private model: string;

    constructor(apiKey: string, model: string = "gemini-1.5-pro") {
        this.client = new GoogleGenerativeAI(apiKey);
        this.model = model;
    }

    async chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMResponse> {
        try {
            const model = this.client.getGenerativeModel({ model: this.model });
            const systemMessage = messages.find(m => m.role === "system");
            const contents = messages
                .filter(m => m.role !== "system")
                .map((m) => ({
                    role: m.role === "assistant" ? "model" : "user",
                    parts: [{ text: m.content }],
                }));
            if (contents.length === 0) {
                throw new Error("No messages to send");
            }

            const generationConfig: Record<string, unknown> = {
                maxOutputTokens: options?.max_tokens ?? 4096,
                temperature: options?.temperature ?? 0.7,
            };

            if (options?.reasoningEffort && options.reasoningEffort !== "none" && supportsGoogleThinking(this.model)) {
                generationConfig.thinkingConfig = {
                    thinkingBudget: GOOGLE_THINKING_BUDGET_BY_EFFORT[options.reasoningEffort],
                };
            }

            const tools = options?.tools && options.tools.length > 0
                ? [{
                    functionDeclarations: options.tools.map((tool) => ({
                        name: tool.name,
                        description: tool.description,
                        parameters: toGoogleSchema(tool.inputSchema),
                    })),
                }]
                : undefined;

            const toolConfig = tools
                ? {
                    functionCallingConfig: {
                        mode: options?.toolChoice === "none" ? "NONE" : "AUTO",
                    },
                }
                : undefined;

            const requestPayload = {
                contents,
                generationConfig,
                tools,
                toolConfig,
                systemInstruction: systemMessage ? systemMessage.content : undefined,
            } as unknown as Parameters<typeof model.generateContent>[0];

            const result = await model.generateContent(requestPayload);
            const response = result.response;

            const toolCalls = response.functionCalls?.()?.map((call) => ({
                name: call.name,
                argumentsText: JSON.stringify(call.args ?? {}),
            }));

            let text = "";
            try {
                text = response.text();
            } catch {
                text = "";
            }

            return {
                content: text,
                toolCalls,
                usage: {
                    total_tokens: response.usageMetadata?.totalTokenCount || 0,
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
