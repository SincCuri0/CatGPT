import { Tool } from "../../core/types";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export const ShellExecuteTool: Tool = {
    id: "shell_execute",
    name: "execute_command",
    description: "Execute a shell command on the local machine. Use with caution.",
    parameters: {
        type: "object",
        properties: {
            command: {
                type: "string",
                description: "The command line instruction to execute."
            }
        },
        required: ["command"]
    },
    execute: async (args: { command: string }) => {
        try {
            // Security warning: exact command execution
            const { stdout, stderr } = await execAsync(args.command);
            if (stderr) {
                return `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`;
            }
            return stdout || "Command executed successfully with no output.";
        } catch (error: any) {
            return `Error execution command: ${error.message}\nSTDOUT: ${error.stdout}\nSTDERR: ${error.stderr}`;
        }
    }
};
