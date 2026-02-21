import { AgentConfig } from "./core/Agent";
import { Conversation } from "./conversations";

export interface SyncDataResponse {
    agents: AgentConfig[];
    conversations: Conversation[];
    hasImportedData?: boolean;
}

export async function fetchSyncData(): Promise<SyncDataResponse> {
    const res = await fetch("/api/sync/pull");
    if (!res.ok) {
        throw new Error("Failed to fetch sync data");
    }
    return res.json();
}
