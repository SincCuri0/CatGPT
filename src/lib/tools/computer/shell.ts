import { Tool } from "../../core/types";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export const ShellExecuteTool: Tool = {
    id: "shell_execute",
    name: "execute_command",
    description: "Execute a shell command on the local machine. Use with caution.",
    inputSchema: {
        type: "object",
        properties: {
            command: {
                type: "string",
                description: "The command line instruction to execute."
            }
        },
        required: ["command"]
    },
    execute: async (args: unknown) => {
        try {
            const command = typeof (args as { command?: unknown })?.command === "string"
                ? (args as { command: string }).command
                : "";
            // Security warning: exact command execution
            const { stdout, stderr } = await execAsync(command);
            if (stderr) {
                return `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`;
            }
            return stdout || "Command executed successfully with no output.";
        } catch (error: unknown) {
            if (error instanceof Error) {
                const detail = error as Error & { stdout?: string; stderr?: string };
                return `Error execution command: ${detail.message}\nSTDOUT: ${detail.stdout ?? ""}\nSTDERR: ${detail.stderr ?? ""}`;
            }
            return `Error execution command: ${String(error)}`;
        }
    }
};
