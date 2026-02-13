import { Tool, ToolArtifact, ToolCheck, ToolExecutionContext, ToolResult } from "../../core/types";
import * as fs from "fs/promises";
import * as path from "path";

// Security: Restrict allowed paths if not in Safe Mode?
// For now, we assume this runs locally and the user controls it. 
// But we might want to default to a workspace directory.

const WORKSPACE_DIR = process.cwd(); // Root of the project or specific workspace
const SQUADS_DIR = "Squads";
const CATS_DIR = "Cats";
const DEFAULT_CAT_DIR = "default-cat";
const MAX_SINGLE_WRITE_CHARS = 12000;

function okResult(output: string, artifacts: ToolArtifact[], checks: ToolCheck[]): ToolResult {
    return {
        ok: true,
        output,
        artifacts,
        checks,
    };
}

function errorResult(error: string, artifacts: ToolArtifact[] = [], checks: ToolCheck[] = []): ToolResult {
    return {
        ok: false,
        error,
        output: error,
        artifacts,
        checks,
    };
}

function asStringField(args: unknown, field: string): string {
    const value = (args as Record<string, unknown> | null)?.[field];
    return typeof value === "string" ? value : "";
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isNodeErrorWithCode(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error;
}

function sanitizeFolderName(raw: string, fallback: string): string {
    const trimmed = raw.trim();
    const safe = trimmed
        .replace(/[^a-zA-Z0-9 _-]+/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
    return safe || fallback;
}

function toWorkspaceRelative(resolvedPath: string): string {
    const relative = path.relative(WORKSPACE_DIR, resolvedPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        return path.normalize(resolvedPath);
    }
    return relative.replace(/\\/g, "/");
}

function isAppScopedRootPath(targetPath: string): boolean {
    const normalized = targetPath.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    return normalized === "squads"
        || normalized.startsWith("squads/")
        || normalized === "cats"
        || normalized.startsWith("cats/");
}

function getDefaultScopeBaseDir(context?: ToolExecutionContext): string {
    const squadName = context?.squadName?.trim();
    if (squadName) {
        return path.join(WORKSPACE_DIR, SQUADS_DIR, sanitizeFolderName(squadName, "default-squad"));
    }

    const agentName = context?.agentName?.trim();
    return path.join(
        WORKSPACE_DIR,
        CATS_DIR,
        sanitizeFolderName(agentName || "", DEFAULT_CAT_DIR),
    );
}

function resolveScopedPath(targetPath: string, context?: ToolExecutionContext): { absolutePath: string; displayPath: string } {
    const requestedPath = targetPath.trim() || ".";
    let resolvedPath: string;

    if (path.isAbsolute(requestedPath)) {
        resolvedPath = path.normalize(requestedPath);
    } else if (isAppScopedRootPath(requestedPath)) {
        resolvedPath = path.resolve(WORKSPACE_DIR, requestedPath);
    } else {
        const scopedBaseDir = getDefaultScopeBaseDir(context);
        resolvedPath = path.resolve(scopedBaseDir, requestedPath);
    }

    return {
        absolutePath: resolvedPath,
        displayPath: toWorkspaceRelative(resolvedPath),
    };
}

export const FileSystemReadTool: Tool = {
    id: "fs_read",
    name: "read_file",
    description: "Read the contents of a file from the local file system.",
    inputSchema: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Relative or absolute path to the file."
            }
        },
        required: ["path"]
    },
    execute: async (args: unknown, context?: ToolExecutionContext) => {
        const targetPath = asStringField(args, "path");
        if (!targetPath.trim()) {
            return errorResult(
                "Error reading file: path must be a non-empty string.",
                [],
                [{ id: "path_non_empty", ok: false, description: "Path argument is required." }],
            );
        }

        try {
            const { absolutePath, displayPath } = resolveScopedPath(targetPath, context);
            const data = await fs.readFile(absolutePath, "utf-8");
            const stat = await fs.stat(absolutePath);
            return okResult(
                data,
                [{
                    kind: "file",
                    label: "file-read",
                    operation: "read",
                    path: displayPath,
                    metadata: {
                        bytesRead: Buffer.byteLength(data, "utf8"),
                        fileSize: stat.size,
                    },
                }],
                [
                    { id: "file_exists", ok: true, description: "File exists and was read." },
                    { id: "read_non_empty_path", ok: true, description: "Path argument was valid." },
                ],
            );
        } catch (error: unknown) {
            return errorResult(`Error reading file: ${getErrorMessage(error)}`);
        }
    }
};

export const FileSystemWriteTool: Tool = {
    id: "fs_write",
    name: "write_file",
    description: "Write content to a file. Supports overwrite or append mode to enable chunked writes for large files.",
    inputSchema: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Path to the file."
            },
            content: {
                type: "string",
                description: "Content to write."
            },
            mode: {
                type: "string",
                enum: ["overwrite", "append"],
                description: "Write mode. Use 'overwrite' to replace file content (default) and 'append' to add a chunk to the end of the file."
            },
            allowTruncate: {
                type: "boolean",
                description: "Set true to intentionally allow overwrite operations that significantly reduce file size."
            }
        },
        required: ["path", "content"]
    },
    execute: async (args: unknown, context?: ToolExecutionContext) => {
        const targetPath = asStringField(args, "path");
        if (!targetPath.trim()) {
            return errorResult(
                "Error writing file: path must be a non-empty string.",
                [],
                [{ id: "path_non_empty", ok: false, description: "Path argument is required." }],
            );
        }

        const content = asStringField(args, "content");
        const rawMode = asStringField(args, "mode").trim().toLowerCase();
        const mode = rawMode === "append" ? "append" : "overwrite";
        const allowTruncate = (args as { allowTruncate?: unknown } | null)?.allowTruncate === true;
        if (content.length > MAX_SINGLE_WRITE_CHARS) {
            return errorResult(
                `Error writing file: content is too large for a single fs_write call (${content.length} chars). Split into chunks <= ${MAX_SINGLE_WRITE_CHARS} chars and use mode='append' after an initial mode='overwrite' call.`,
                [],
                [{ id: "max_single_write_chars", ok: false, description: "Payload exceeded max single-write threshold." }],
            );
        }

        try {
            const { absolutePath, displayPath } = resolveScopedPath(targetPath, context);
            await fs.mkdir(path.dirname(absolutePath), { recursive: true });
            let filePreviouslyExists = false;
            let existingContent = "";
            try {
                existingContent = await fs.readFile(absolutePath, "utf-8");
                filePreviouslyExists = true;
            } catch (error: unknown) {
                if (!(isNodeErrorWithCode(error) && error.code === "ENOENT")) {
                    throw error;
                }
            }

            if (filePreviouslyExists && rawMode.length === 0) {
                return errorResult(
                    `Error writing file: mode must be explicit when overwriting an existing file (${displayPath}). Use mode='append' to extend or mode='overwrite' for full replacement.`,
                    [{
                        kind: "file",
                        label: "file-write",
                        operation: "write",
                        path: displayPath,
                        metadata: {
                            existingBytes: Buffer.byteLength(existingContent, "utf8"),
                            requestedBytes: Buffer.byteLength(content, "utf8"),
                        },
                    }],
                    [{
                        id: "mode_explicit_for_existing_file",
                        ok: false,
                        description: "Write mode was omitted for an existing file.",
                    }],
                );
            }

            if (filePreviouslyExists && mode === "overwrite" && !allowTruncate) {
                const existingBytes = Buffer.byteLength(existingContent, "utf8");
                const requestedBytes = Buffer.byteLength(content, "utf8");
                const significantTruncation = existingBytes >= 800 && requestedBytes < Math.floor(existingBytes * 0.7);

                if (significantTruncation) {
                    return errorResult(
                        `Error writing file: overwrite would significantly truncate ${displayPath} (${requestedBytes}B < 70% of ${existingBytes}B). Use mode='append' or retry with allowTruncate=true if intentional.`,
                        [{
                            kind: "file",
                            label: "file-write",
                            operation: "write",
                            path: displayPath,
                            metadata: {
                                mode,
                                existingBytes,
                                requestedBytes,
                            },
                        }],
                        [{
                            id: "overwrite_truncation_guard",
                            ok: false,
                            description: "Significant truncation blocked to prevent accidental data loss.",
                        }],
                    );
                }
            }

            if (mode === "append") {
                await fs.appendFile(absolutePath, content, "utf-8");
            } else {
                await fs.writeFile(absolutePath, content, "utf-8");
            }

            const persisted = await fs.readFile(absolutePath, "utf-8");
            const stat = await fs.stat(absolutePath);
            const contentCheck = mode === "append"
                ? persisted.endsWith(content)
                : persisted === content;
            const existsCheck = stat.isFile();
            const checks: ToolCheck[] = [
                { id: "file_exists_after_write", ok: existsCheck, description: "Target file exists after write operation." },
                {
                    id: "content_verification",
                    ok: contentCheck,
                    description: mode === "append"
                        ? "File ends with appended content."
                        : "File content matches written payload.",
                },
            ];

            if (!existsCheck || !contentCheck) {
                const artifactOperation = mode === "append" ? "append" : "write";
                return errorResult(
                    `Error writing file: verification failed for ${displayPath}.`,
                    [{
                        kind: "file",
                        label: "file-write",
                        operation: artifactOperation,
                        path: displayPath,
                        metadata: {
                            mode,
                            bytesRequested: Buffer.byteLength(content, "utf8"),
                            fileSize: stat.size,
                        },
                    }],
                    checks,
                );
            }

            const artifactOperation = mode === "append" ? "append" : "write";
            return okResult(
                mode === "append"
                    ? `Successfully appended to ${displayPath}`
                    : `Successfully wrote to ${displayPath}`,
                [{
                    kind: "file",
                    label: "file-write",
                    operation: artifactOperation,
                    path: displayPath,
                    metadata: {
                        mode,
                        bytesRequested: Buffer.byteLength(content, "utf8"),
                        fileSize: stat.size,
                    },
                }],
                checks,
            );
        } catch (error: unknown) {
            return errorResult(`Error writing file: ${getErrorMessage(error)}`);
        }
    }
};

export const FileSystemListTool: Tool = {
    id: "fs_list",
    name: "list_directory",
    description: "List files and directories in a given path.",
    inputSchema: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Path to the directory."
            }
        },
        required: ["path"]
    },
    execute: async (args: unknown, context?: ToolExecutionContext) => {
        const targetPath = asStringField(args, "path");
        if (!targetPath.trim()) {
            return errorResult(
                "Error listing directory: path must be a non-empty string.",
                [],
                [{ id: "path_non_empty", ok: false, description: "Path argument is required." }],
            );
        }

        try {
            const { absolutePath, displayPath } = resolveScopedPath(targetPath, context);
            const items = await fs.readdir(absolutePath, { withFileTypes: true });
            const output = items.map(item => `${item.isDirectory() ? '[DIR]' : '[FILE]'} ${item.name}`).join("\n");
            return okResult(
                output,
                [{
                    kind: "file",
                    label: "directory-list",
                    operation: "list",
                    path: displayPath,
                    metadata: {
                        itemCount: items.length,
                    },
                }],
                [{ id: "directory_listed", ok: true, description: "Directory contents were listed successfully." }],
            );
        } catch (error: unknown) {
            return errorResult(`Error listing directory: ${getErrorMessage(error)}`);
        }
    }
}
