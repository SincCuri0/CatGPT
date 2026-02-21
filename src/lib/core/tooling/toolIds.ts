const CANONICAL_TOOL_IDS = new Set([
    "web_search",
    "shell_execute",
    "mcp_all",
    "subagents",
]);

const LEGACY_TOOL_ID_ALIASES: Record<string, string> = {
    fs_read: "mcp_all",
    fs_write: "mcp_all",
    fs_list: "mcp_all",
    read_file: "mcp_all",
    write_file: "mcp_all",
    list_directory: "mcp_all",
    execute_command: "shell_execute",
    search_internet: "web_search",
};

const PRIVILEGED_TOOL_IDS = new Set([
    "shell_execute",
    "mcp_all",
]);

export function normalizeToolIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const deduped: string[] = [];
    const seen = new Set<string>();

    for (const entry of value) {
        if (typeof entry !== "string") continue;
        const normalized = entry.trim().toLowerCase();
        if (!normalized) continue;

        const canonical = LEGACY_TOOL_ID_ALIASES[normalized] || normalized;
        if (!CANONICAL_TOOL_IDS.has(canonical)) continue;
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        deduped.push(canonical);
    }

    return deduped;
}

export function hasPrivilegedToolCapability(value: unknown): boolean {
    const toolIds = normalizeToolIds(value);
    return toolIds.some((toolId) => PRIVILEGED_TOOL_IDS.has(toolId));
}
