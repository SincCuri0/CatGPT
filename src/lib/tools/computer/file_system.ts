import { Tool } from "../../core/types";
import * as fs from "fs/promises";
import * as path from "path";

// Security: Restrict allowed paths if not in Safe Mode?
// For now, we assume this runs locally and the user controls it. 
// But we might want to default to a workspace directory.

const WORKSPACE_DIR = process.cwd(); // Root of the project or specific workspace

function asStringField(args: unknown, field: string): string {
    const value = (args as Record<string, unknown> | null)?.[field];
    return typeof value === "string" ? value : "";
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
    execute: async (args: unknown) => {
        try {
            const targetPath = asStringField(args, "path");
            const filePath = path.resolve(WORKSPACE_DIR, targetPath);
            const data = await fs.readFile(filePath, "utf-8");
            return data;
        } catch (error: unknown) {
            return `Error reading file: ${getErrorMessage(error)}`;
        }
    }
};

export const FileSystemWriteTool: Tool = {
    id: "fs_write",
    name: "write_file",
    description: "Write content to a file. Creates the file if it doesn't exist.",
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
            }
        },
        required: ["path", "content"]
    },
    execute: async (args: unknown) => {
        try {
            const targetPath = asStringField(args, "path");
            const content = asStringField(args, "content");
            const filePath = path.resolve(WORKSPACE_DIR, targetPath);
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, content, "utf-8");
            return `Successfully wrote to ${targetPath}`;
        } catch (error: unknown) {
            return `Error writing file: ${getErrorMessage(error)}`;
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
    execute: async (args: unknown) => {
        try {
            const targetPath = asStringField(args, "path");
            const dirPath = path.resolve(WORKSPACE_DIR, targetPath);
            const items = await fs.readdir(dirPath, { withFileTypes: true });
            return items.map(item => `${item.isDirectory() ? '[DIR]' : '[FILE]'} ${item.name}`).join("\n");
        } catch (error: unknown) {
            return `Error listing directory: ${getErrorMessage(error)}`;
        }
    }
}
