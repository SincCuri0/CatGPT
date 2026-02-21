import fs from "fs/promises";
import path from "path";

export interface RuntimeKeyValueStore<TValue = unknown> {
    get(key: string): Promise<TValue | null>;
    set(key: string, value: TValue): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
}

function sanitizeStoreKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9._/-]+/g, "_").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

function toRelativeFilePath(key: string, extension: string): string {
    const normalized = sanitizeStoreKey(key);
    if (!normalized) throw new Error("Runtime store key cannot be empty.");
    return `${normalized}${extension}`;
}

export class InMemoryRuntimeKeyValueStore<TValue = unknown> implements RuntimeKeyValueStore<TValue> {
    private readonly values = new Map<string, TValue>();

    async get(key: string): Promise<TValue | null> {
        return this.values.has(key) ? (this.values.get(key) as TValue) : null;
    }

    async set(key: string, value: TValue): Promise<void> {
        this.values.set(key, value);
    }

    async delete(key: string): Promise<void> {
        this.values.delete(key);
    }

    async list(prefix = ""): Promise<string[]> {
        const normalizedPrefix = sanitizeStoreKey(prefix);
        return Array.from(this.values.keys()).filter((key) => (
            !normalizedPrefix || key.startsWith(normalizedPrefix)
        ));
    }
}

export interface JsonFileRuntimeStoreOptions {
    baseDir: string;
    extension?: `.${string}`;
    prettyPrint?: boolean;
}

export class JsonFileRuntimeKeyValueStore<TValue = unknown> implements RuntimeKeyValueStore<TValue> {
    private readonly baseDir: string;
    private readonly extension: `.${string}`;
    private readonly prettyPrint: boolean;

    constructor(options: JsonFileRuntimeStoreOptions) {
        this.baseDir = options.baseDir;
        this.extension = options.extension ?? ".json";
        this.prettyPrint = options.prettyPrint ?? true;
    }

    private resolveFilePath(key: string): string {
        const relativePath = toRelativeFilePath(key, this.extension);
        const filePath = path.resolve(this.baseDir, relativePath);
        const normalizedBaseDir = path.resolve(this.baseDir);
        if (!filePath.startsWith(normalizedBaseDir)) {
            throw new Error(`Invalid runtime store key path '${key}'.`);
        }
        return filePath;
    }

    async get(key: string): Promise<TValue | null> {
        try {
            const filePath = this.resolveFilePath(key);
            const raw = await fs.readFile(filePath, "utf-8");
            return JSON.parse(raw) as TValue;
        } catch (error) {
            const nodeError = error as NodeJS.ErrnoException;
            if (nodeError.code === "ENOENT") return null;
            throw error;
        }
    }

    async set(key: string, value: TValue): Promise<void> {
        const filePath = this.resolveFilePath(key);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const serialized = this.prettyPrint
            ? JSON.stringify(value, null, 2)
            : JSON.stringify(value);
        await fs.writeFile(filePath, `${serialized}\n`, "utf-8");
    }

    async delete(key: string): Promise<void> {
        try {
            await fs.unlink(this.resolveFilePath(key));
        } catch (error) {
            const nodeError = error as NodeJS.ErrnoException;
            if (nodeError.code !== "ENOENT") throw error;
        }
    }

    async list(prefix = ""): Promise<string[]> {
        const normalizedPrefix = sanitizeStoreKey(prefix);
        const files: string[] = [];

        const walk = async (directory: string): Promise<void> => {
            try {
                const entries = await fs.readdir(directory, { withFileTypes: true, encoding: "utf8" });
                for (const entry of entries) {
                    const absolute = path.join(directory, entry.name);
                    if (entry.isDirectory()) {
                        await walk(absolute);
                        continue;
                    }
                    if (!entry.isFile() || !entry.name.endsWith(this.extension)) continue;
                    const relativePath = path.relative(this.baseDir, absolute).replace(/\\/g, "/");
                    const key = relativePath.slice(0, relativePath.length - this.extension.length);
                    files.push(key);
                }
            } catch (error) {
                const nodeError = error as NodeJS.ErrnoException;
                if (nodeError.code === "ENOENT") return;
                throw error;
            }
        };

        await walk(this.baseDir);
        return files.filter((key) => !normalizedPrefix || key.startsWith(normalizedPrefix));
    }
}
