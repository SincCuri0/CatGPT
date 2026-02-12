import { Tool } from "../../core/types";
import * as fs from "fs/promises";
import * as path from "path";

// Security: Restrict allowed paths if not in Safe Mode?
// For now, we assume this runs locally and the user controls it. 
// But we might want to default to a workspace directory.

const WORKSPACE_DIR = process.cwd(); // Root of the project or specific workspace

export const FileSystemReadTool: Tool = {
    id: "fs_read",
    name: "read_file",
    description: "Read the contents of a file from the local file system.",
    parameters: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Relative or absolute path to the file."
            }
        },
        required: ["path"]
    },
    execute: async (args: { path: string }) => {
        try {
            const filePath = path.resolve(WORKSPACE_DIR, args.path);
            const data = await fs.readFile(filePath, "utf-8");
            return data;
        } catch (error: any) {
            return `Error reading file: ${error.message}`;
        }
    }
};

export const FileSystemWriteTool: Tool = {
    id: "fs_write",
    name: "write_file",
    description: "Write content to a file. Creates the file if it doesn't exist.",
    parameters: {
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
    execute: async (args: { path: string; content: string }) => {
        try {
            const filePath = path.resolve(WORKSPACE_DIR, args.path);
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, args.content, "utf-8");
            return `Successfully wrote to ${args.path}`;
        } catch (error: any) {
            return `Error writing file: ${error.message}`;
        }
    }
};

export const FileSystemListTool: Tool = {
    id: "fs_list",
    name: "list_directory",
    description: "List files and directories in a given path.",
    parameters: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Path to the directory."
            }
        },
        required: ["path"]
    },
    execute: async (args: { path: string }) => {
        try {
            const dirPath = path.resolve(WORKSPACE_DIR, args.path);
            const items = await fs.readdir(dirPath, { withFileTypes: true });
            return items.map(item => `${item.isDirectory() ? '[DIR]' : '[FILE]'} ${item.name}`).join("\n");
        } catch (error: any) {
            return `Error listing directory: ${error.message}`;
        }
    }
}
