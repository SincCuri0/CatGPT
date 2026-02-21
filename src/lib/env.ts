import fs from "fs/promises";
import path from "path";

const ENV_PATH = path.join(process.cwd(), ".env");
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const ENV_LINE_PATTERN = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/;

function decodeEnvValue(rawValue: string): string {
    const trimmed = rawValue.trim();
    if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        const unwrapped = trimmed.slice(1, -1);
        return unwrapped
            .replace(/\\n/g, "\n")
            .replace(/\\r/g, "\r")
            .replace(/\\"/g, "\"")
            .replace(/\\\\/g, "\\");
    }
    return trimmed;
}

function normalizeEnvValue(value: string): string {
    return value.replace(/\u0000/g, "").replace(/[\r\n]+/g, "").trim();
}

function parseEnvLine(line: string): { key: string; value: string } | null {
    const match = line.match(ENV_LINE_PATTERN);
    if (!match) return null;
    return {
        key: match[1],
        value: decodeEnvValue(match[2]),
    };
}

export async function getEnvVariable(key: string): Promise<string | null> {
    if (process.env[key]) {
        return process.env[key] as string;
    }

    try {
        const fileContent = await fs.readFile(ENV_PATH, "utf-8");
        const lines = fileContent.split(/\r?\n/);
        for (const line of lines) {
            const parsed = parseEnvLine(line);
            if (parsed?.key === key) {
                return parsed.value;
            }
        }
        return null;
    } catch {
        return null;
    }
}

export async function setEnvVariable(key: string, value: string): Promise<void> {
    if (!ENV_KEY_PATTERN.test(key)) {
        throw new Error(`Invalid environment variable key: ${key}`);
    }

    const normalizedValue = normalizeEnvValue(value || "");

    try {
        let fileContent = "";
        try {
            fileContent = await fs.readFile(ENV_PATH, "utf-8");
        } catch {
            // File does not exist yet.
        }

        const lines = fileContent.split(/\r?\n/);
        let found = false;
        const newLines = lines.flatMap((line) => {
            const parsed = parseEnvLine(line);
            if (parsed?.key === key) {
                found = true;
                if (!normalizedValue) return [];
                return [`${key}=${normalizedValue}`];
            }
            return [line];
        });

        if (!found && normalizedValue) {
            newLines.push(`${key}=${normalizedValue}`);
        }

        const content = `${newLines.join("\n").trimEnd()}\n`;
        await fs.writeFile(ENV_PATH, content, "utf-8");
        if (normalizedValue) {
            process.env[key] = normalizedValue;
        } else {
            delete process.env[key];
        }
    } catch (error) {
        console.error("Failed to write to .env file", error);
        throw error;
    }
}

export async function getAllApiKeys(): Promise<Record<string, boolean>> {
    const keys = ["GROQ_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "ELEVENLABS_API_KEY"];
    const result: Record<string, boolean> = {};

    for (const key of keys) {
        const val = await getEnvVariable(key);
        result[key] = !!val && val.length > 0 && val !== "null";
    }
    return result;
}
