import { Tool, ToolCheck, ToolResult } from "../../core/types";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

function shellSuccessResult(
    command: string,
    output: string,
    stderr: string,
): ToolResult {
    const checks: ToolCheck[] = [
        { id: "command_non_empty", ok: true, description: "Command argument was provided." },
        { id: "command_executed", ok: true, description: "Command executed successfully." },
        { id: "exit_code_zero", ok: true, description: "Command exited with status code 0." },
    ];

    return {
        ok: true,
        output,
        artifacts: [{
            kind: "shell",
            label: "command-execution",
            operation: "execute",
            metadata: {
                command,
                exitCode: 0,
                stdoutBytes: Buffer.byteLength(output, "utf8"),
                stderrBytes: Buffer.byteLength(stderr, "utf8"),
            },
        }],
        checks,
    };
}

function shellErrorResult(
    error: string,
    command: string,
    stdout: string,
    stderr: string,
    exitCode: number | string | null,
): ToolResult {
    return {
        ok: false,
        error,
        output: error,
        artifacts: [{
            kind: "shell",
            label: "command-execution",
            operation: "execute",
            metadata: {
                command,
                exitCode,
                stdoutBytes: Buffer.byteLength(stdout, "utf8"),
                stderrBytes: Buffer.byteLength(stderr, "utf8"),
            },
        }],
        checks: [
            { id: "command_non_empty", ok: Boolean(command.trim()), description: "Command argument was provided." },
            { id: "command_executed", ok: false, description: "Command execution failed." },
            { id: "exit_code_zero", ok: false, description: "Command exited with a non-zero status code." },
        ],
    };
}

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
        const command = typeof (args as { command?: unknown })?.command === "string"
            ? (args as { command: string }).command
            : "";
        if (!command.trim()) {
            return {
                ok: false,
                error: "Error execution command: command must be a non-empty string.",
                output: "Error execution command: command must be a non-empty string.",
                artifacts: [],
                checks: [{ id: "command_non_empty", ok: false, description: "Command argument is required." }],
            };
        }

        try {
            // Security warning: exact command execution
            const { stdout, stderr } = await execAsync(command, {
                cwd: process.cwd(),
                timeout: 120_000,
                maxBuffer: 2 * 1024 * 1024,
            });
            const output = stderr
                ? `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`
                : (stdout || "Command executed successfully with no output.");
            return shellSuccessResult(command, output, stderr);
        } catch (error: unknown) {
            if (error instanceof Error) {
                const detail = error as Error & { stdout?: string; stderr?: string; code?: number | string };
                const formatted = `Error execution command: ${detail.message}\nSTDOUT: ${detail.stdout ?? ""}\nSTDERR: ${detail.stderr ?? ""}`;
                return shellErrorResult(
                    formatted,
                    command,
                    detail.stdout ?? "",
                    detail.stderr ?? "",
                    detail.code ?? null,
                );
            }
            const formatted = `Error execution command: ${String(error)}`;
            return shellErrorResult(formatted, command, "", "", null);
        }
    }
};
