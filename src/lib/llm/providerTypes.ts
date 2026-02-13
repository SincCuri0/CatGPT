import { LLMClient } from "./types";

export interface ProviderConfig {
    id: string;
    name: string;
    description: string;
    defaultModel: string;
    models: { id: string; label: string; description?: string }[];
    requiresApiKey: boolean;
    apiKeyLink?: string;
}

export abstract class LLMProvider {
    abstract get config(): ProviderConfig;
    abstract createClient(apiKey: string, model?: string): LLMClient;
}
