import type { NextRequest } from "next/server";
import { getEnvVariable } from "@/lib/env";

const PROVIDER_ENV_KEY_MAP: Record<string, string> = {
  groq: "GROQ_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
};

function parseApiKeysHeader(rawHeader: string | null): Record<string, string> {
  if (!rawHeader) return {};
  try {
    const parsed = JSON.parse(rawHeader) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export async function resolveApiKeys(req: NextRequest): Promise<Record<string, string | null>> {
  const clientKeys = parseApiKeysHeader(req.headers.get("x-api-keys"));
  const resolved: Record<string, string | null> = {};

  for (const [providerId, envVar] of Object.entries(PROVIDER_ENV_KEY_MAP)) {
    const providedKey = clientKeys[providerId];
    if (typeof providedKey === "string" && providedKey.trim().length > 0 && providedKey !== "null") {
      resolved[providerId] = providedKey.trim();
    } else {
      resolved[providerId] = await getEnvVariable(envVar);
    }
  }

  return resolved;
}

