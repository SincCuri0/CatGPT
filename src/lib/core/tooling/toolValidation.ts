import { ToolInputSchema } from "../types";

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesPrimitiveType(type: string, value: unknown): boolean {
    if (type === "string") return typeof value === "string";
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    if (type === "integer") return typeof value === "number" && Number.isInteger(value);
    if (type === "boolean") return typeof value === "boolean";
    if (type === "object") return isObject(value);
    if (type === "array") return Array.isArray(value);
    return true;
}

export interface ToolValidationResult {
    ok: boolean;
    errors: string[];
}

export function validateToolArgs(
    schema: ToolInputSchema,
    args: unknown,
): ToolValidationResult {
    if (!isObject(args)) {
        return { ok: false, errors: ["Arguments must be an object."] };
    }

    const required = schema.required ?? [];
    const missing = required.filter((field) => !(field in args));
    if (missing.length > 0) {
        return {
            ok: false,
            errors: missing.map((field) => `Missing required argument '${field}'.`),
        };
    }

    const errors: string[] = [];
    for (const [field, fieldSchema] of Object.entries(schema.properties)) {
        if (!(field in args)) continue;
        const value = args[field];

        if (fieldSchema && typeof fieldSchema === "object" && "type" in fieldSchema) {
            const fieldType = (fieldSchema as { type?: string }).type;
            if (typeof fieldType === "string" && !matchesPrimitiveType(fieldType, value)) {
                errors.push(
                    `Invalid type for '${field}'. Expected '${fieldType}'.`,
                );
            }
        }
    }

    return { ok: errors.length === 0, errors };
}
