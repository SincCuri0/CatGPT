import fs from "fs/promises";
import path from "path";

const ENV_PATH = path.join(process.cwd(), ".env");

export async function getEnvVariable(key: string): Promise<string | null> {
    // Check process.env first (System Environment Variables or loaded by Next.js at startup)
    if (process.env[key]) {
        return process.env[key] as string;
    }

    try {
        const fileContent = await fs.readFile(ENV_PATH, "utf-8");
        const lines = fileContent.split("\n");
        for (const line of lines) {
            const [k, ...vParts] = line.split("=");
            if (k.trim() === key) {
                return vParts.join("=").trim();
            }
        }
        return null;
    } catch (e) {
        return null;
    }
}

export async function setEnvVariable(key: string, value: string): Promise<void> {
    try {
        let fileContent = "";
        try {
            fileContent = await fs.readFile(ENV_PATH, "utf-8");
        } catch {
            // File might not exist
        }

        const lines = fileContent.split("\n");
        let found = false;
        const newLines = lines.map(line => {
            const [k] = line.split("=");
            if (k.trim() === key) {
                found = true;
                return `${key}=${value}`;
            }
            return line;
        });

        if (!found) {
            newLines.push(`${key}=${value}`);
        }

        await fs.writeFile(ENV_PATH, newLines.join("\n"));
        // Update process.env for immediate use in this process
        process.env[key] = value;
    } catch (e) {
        console.error("Failed to write to .env file", e);
        throw e;
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
