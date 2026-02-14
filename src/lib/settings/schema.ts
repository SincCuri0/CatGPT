import { DEFAULT_LOCAL_MCP_SERVICES } from "@/lib/mcp/defaultServices";
import type { McpServiceConfig, McpSettings } from "@/lib/mcp/types";

export const SIDEBAR_WIDTH_MIN = 260;
export const SIDEBAR_WIDTH_MAX = SIDEBAR_WIDTH_MIN * 2;
export const DEFAULT_SIDEBAR_WIDTH = SIDEBAR_WIDTH_MIN;
export const USER_SETTINGS_VERSION = 1;
export const MCP_SERVICE_ID_PATTERN = "^[a-z0-9][a-z0-9_-]{1,63}$";
export const MCP_SERVICE_TIMEOUT_MIN = 1_000;
export const MCP_SERVICE_TIMEOUT_MAX = 120_000;
export const MCP_SERVICE_TIMEOUT_DEFAULT = 12_000;

export interface UiSettings {
  sidebarWidth: number;
}

export interface UserSettings {
  version: number;
  ui: UiSettings;
  mcp: McpSettings;
}

export interface UserSettingsPatch {
  ui?: Partial<UiSettings>;
  mcp?: Partial<McpSettings>;
}

export const MCP_SERVICE_CONFIG_JSON_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", pattern: MCP_SERVICE_ID_PATTERN },
    name: { type: "string", minLength: 1, maxLength: 120 },
    description: { type: "string", maxLength: 300 },
    enabled: { type: "boolean" },
    transport: { type: "string", enum: ["stdio"] },
    command: { type: "string", minLength: 1 },
    args: {
      type: "array",
      items: { type: "string" },
      maxItems: 64,
    },
    cwd: { type: "string" },
    env: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    timeoutMs: {
      type: "integer",
      minimum: MCP_SERVICE_TIMEOUT_MIN,
      maximum: MCP_SERVICE_TIMEOUT_MAX,
    },
  },
  required: ["id", "name", "enabled", "transport", "command", "args"],
  additionalProperties: false,
} as const;

export const MCP_SETTINGS_JSON_SCHEMA = {
  type: "object",
  properties: {
    services: {
      type: "array",
      items: MCP_SERVICE_CONFIG_JSON_SCHEMA,
    },
  },
  required: ["services"],
  additionalProperties: false,
} as const;

export const USER_SETTINGS_JSON_SCHEMA = {
  type: "object",
  properties: {
    version: { type: "integer", minimum: 1 },
    ui: {
      type: "object",
      properties: {
        sidebarWidth: {
          type: "number",
          minimum: SIDEBAR_WIDTH_MIN,
          maximum: SIDEBAR_WIDTH_MAX,
        },
      },
      required: ["sidebarWidth"],
      additionalProperties: false,
    },
    mcp: MCP_SETTINGS_JSON_SCHEMA,
  },
  required: ["version", "ui", "mcp"],
  additionalProperties: false,
} as const;

export const DEFAULT_USER_SETTINGS: UserSettings = {
  version: USER_SETTINGS_VERSION,
  ui: {
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  },
  mcp: {
    services: DEFAULT_LOCAL_MCP_SERVICES.map((service) => ({ ...service })),
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const sanitizeText = (value: unknown, fallback = ""): string => (
  typeof value === "string" ? value.trim() : fallback
);

const clampNumber = (value: number, min: number, max: number): number => (
  Math.min(max, Math.max(min, value))
);

export const clampSidebarWidth = (value: number): number => (
  clampNumber(value, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX)
);

function sanitizeStringList(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, 64);
}

function sanitizeEnvMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const safeKey = sanitizeText(key);
    if (!safeKey) continue;
    if (typeof raw !== "string") continue;
    out[safeKey] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeTimeoutMs(value: unknown, fallback = MCP_SERVICE_TIMEOUT_DEFAULT): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clampNumber(Math.floor(value), MCP_SERVICE_TIMEOUT_MIN, MCP_SERVICE_TIMEOUT_MAX);
}

function sanitizeMcpServiceConfig(
  value: unknown,
  fallback: McpServiceConfig,
): McpServiceConfig {
  const source = isRecord(value) ? value : {};
  const id = sanitizeText(source.id, fallback.id).toLowerCase();
  const safeId = id.match(/^[a-z0-9][a-z0-9_-]{1,63}$/) ? id : fallback.id;
  const command = sanitizeText(source.command, fallback.command);
  const args = sanitizeStringList(source.args, fallback.args);

  return {
    id: safeId,
    name: sanitizeText(source.name, fallback.name) || fallback.name,
    description: sanitizeText(source.description, fallback.description || "") || undefined,
    enabled: typeof source.enabled === "boolean" ? source.enabled : fallback.enabled,
    transport: source.transport === "stdio" ? "stdio" : fallback.transport,
    command: command || fallback.command,
    args: args.length > 0 ? args : [...fallback.args],
    cwd: sanitizeText(source.cwd, fallback.cwd || "") || undefined,
    env: sanitizeEnvMap(source.env) || fallback.env,
    timeoutMs: sanitizeTimeoutMs(source.timeoutMs, fallback.timeoutMs || MCP_SERVICE_TIMEOUT_DEFAULT),
  };
}

function sanitizeMcpSettings(input: unknown): McpSettings {
  const source = isRecord(input) ? input : {};
  const incomingServices = Array.isArray(source.services) ? source.services : [];

  const defaultById = new Map(DEFAULT_LOCAL_MCP_SERVICES.map((service) => [service.id, service]));
  const seen = new Set<string>();
  const sanitizedIncoming: McpServiceConfig[] = [];

  for (const rawEntry of incomingServices) {
    const entry = (() => {
      if (!isRecord(rawEntry)) return rawEntry;
      const rawId = sanitizeText(rawEntry.id).toLowerCase();
      // Migration: legacy invalid default service -> valid upstream server package
      if (rawId === "mcp-fetch") {
        return {
          ...rawEntry,
          id: "mcp-sequential-thinking",
          name: sanitizeText(rawEntry.name) || "Sequential Thinking MCP",
          description: "Structured reasoning/planning tools via MCP.",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
          transport: "stdio",
          timeoutMs: sanitizeTimeoutMs(rawEntry.timeoutMs, MCP_SERVICE_TIMEOUT_DEFAULT),
        };
      }
      return rawEntry;
    })();

    if (!isRecord(entry)) continue;
    const rawId = sanitizeText(entry.id).toLowerCase();
    if (!rawId || seen.has(rawId)) continue;
    seen.add(rawId);
    const fallback = defaultById.get(rawId) || {
      id: rawId,
      name: rawId,
      enabled: false,
      transport: "stdio" as const,
      command: "",
      args: [],
      timeoutMs: MCP_SERVICE_TIMEOUT_DEFAULT,
    };
    sanitizedIncoming.push(sanitizeMcpServiceConfig(entry, fallback));
  }

  for (const defaultService of DEFAULT_LOCAL_MCP_SERVICES) {
    if (seen.has(defaultService.id)) continue;
    sanitizedIncoming.push({ ...defaultService });
  }

  return {
    services: sanitizedIncoming,
  };
}

export function sanitizeUserSettings(input: unknown): UserSettings {
  if (!isRecord(input)) return DEFAULT_USER_SETTINGS;

  const ui = isRecord(input.ui) ? input.ui : {};
  const rawSidebarWidth = typeof ui.sidebarWidth === "number"
    ? ui.sidebarWidth
    : DEFAULT_USER_SETTINGS.ui.sidebarWidth;

  return {
    version: USER_SETTINGS_VERSION,
    ui: {
      sidebarWidth: clampSidebarWidth(rawSidebarWidth),
    },
    mcp: sanitizeMcpSettings(input.mcp),
  };
}

export function mergeUserSettings(
  current: UserSettings,
  patch: UserSettingsPatch,
): UserSettings {
  return sanitizeUserSettings({
    ...current,
    ...patch,
    ui: {
      ...current.ui,
      ...(patch.ui || {}),
    },
    mcp: {
      ...current.mcp,
      ...(patch.mcp || {}),
    },
  });
}
