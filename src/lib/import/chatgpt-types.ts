/**
 * ChatGPT Data Export Types
 * Based on analysis of conversations.json and official export documentation.
 */

export interface ChatGPTDetails {
    // Top-level export structure (conversations.json is an array of these)
    title: string;
    create_time: number;
    update_time: number;
    mapping: Record<string, MappingNode>; // Tree structure of messages
    current_node: string; // The leaf node of the active path
    conversation_id: string; // UUID

    // Metadata
    is_archived?: boolean;
    default_model_slug?: string;
    conversation_template_id?: string; // Present for "Project" conversations
    gizmo_id?: string; // Present for "Custom GPT" conversations
    voice?: unknown; // Voice mode metadata (if any)
}

export interface MappingNode {
    id: string;
    message: ChatGPTMessage | null; // null for system/root nodes
    parent: string | null;
    children: string[];
}

export interface ChatGPTMessage {
    id: string;
    author: {
        role: "system" | "user" | "assistant" | "tool";
        name?: string;
        metadata?: any;
    };
    create_time: number | null;
    update_time: number | null;
    content: {
        content_type: "text" | "multimodal_text" | "code" | "execution_output" | "tether_browsing_display" | "tether_quote";
        parts?: (string | MultimodalPart | TetherPart)[];
        text?: string; // for code execution output
        result?: string; // for tool outputs
        language?: string; // for code blocks
    };
    status: "finished_successfully" | "finished_incomplete" | "error";
    end_turn?: boolean;
    weight?: number; // 0 = hidden/skipped message
    metadata?: {
        model_slug?: string;
        is_visually_hidden_from_conversation?: boolean;
        timestamp_: string; // often "absolute"
        [key: string]: any;
    };
}

export interface MultimodalPart {
    content_type: "image_asset_pointer" | "video_asset_pointer";
    asset_pointer: string;
    size_bytes?: number;
    width?: number;
    height?: number;
}

export interface TetherPart {
    content_type: "tether_quote";
    title?: string;
    url?: string;
    text?: string;
}

// ───────────────────────────────────────────
// Scan Results (Metadata)
// ───────────────────────────────────────────

export interface GPTSummary {
    id: string; // gizmo_id or "default"
    name: string; // Inferred from conversation titles
    conversations: number;
    messageCount: number;
    lastActive: number;
    modelDistribution: Record<string, number>;
}

export interface DiscoveredConversation {
    id: string;
    title: string;
    create_time: number;
    update_time: number;
    message_count: number;
    is_archived: boolean;
    // Categorization
    category: "default" | "gpt" | "project";
    gizmo_id?: string;
    conversation_template_id?: string;
    isImported?: boolean;
}

export interface ExportScanResult {
    totalConversations: number;
    totalMessages: number;
    dateRange: {
        start: number;
        end: number;
    };
    gpts: Record<string, GPTSummary>;
    projects: Record<string, GPTSummary>;
    conversations: DiscoveredConversation[];
}
