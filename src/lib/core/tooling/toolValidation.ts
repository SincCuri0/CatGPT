import { ToolInputSchema, ToolSchemaProperty, ToolSchemaPrimitiveType } from "../types";
import { parseJsonWithRecovery } from "./toolArgParsing";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return isRecord(value) ? value : null;
}

function coercePrimitive(
    expectedType: ToolSchemaPrimitiveType,
    value: unknown,
): { ok: boolean; value: unknown } {
    if (expectedType === "string") {
        if (typeof value === "string") return { ok: true, value };
        if (value === null || value === undefined) return { ok: false, value };
        if (typeof value === "number" || typeof value === "boolean") {
            return { ok: true, value: String(value) };
        }
        return { ok: false, value };
    }

    if (expectedType === "number") {
        if (typeof value === "number" && Number.isFinite(value)) return { ok: true, value };
        if (typeof value === "string" && value.trim().length > 0) {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) return { ok: true, value: parsed };
        }
        return { ok: false, value };
    }

    if (expectedType === "integer") {
        if (typeof value === "number" && Number.isInteger(value)) return { ok: true, value };
        if (typeof value === "string" && value.trim().length > 0) {
            const parsed = Number(value);
            if (Number.isInteger(parsed)) return { ok: true, value: parsed };
        }
        return { ok: false, value };
    }

    if (expectedType === "boolean") {
        if (typeof value === "boolean") return { ok: true, value };
        if (typeof value === "string") {
            const normalized = value.trim().toLowerCase();
            if (normalized === "true") return { ok: true, value: true };
            if (normalized === "false") return { ok: true, value: false };
        }
        return { ok: false, value };
    }

    if (expectedType === "object") {
        if (isRecord(value)) return { ok: true, value };
        if (typeof value === "string") {
            const parsed = parseJsonWithRecovery<unknown>(value);
            if (isRecord(parsed)) return { ok: true, value: parsed };
        }
        return { ok: false, value };
    }

    if (expectedType === "array") {
        if (Array.isArray(value)) return { ok: true, value };
        if (typeof value === "string") {
            const parsed = parseJsonWithRecovery<unknown>(value);
            if (Array.isArray(parsed)) return { ok: true, value: parsed };
        }
        return { ok: false, value };
    }

    return { ok: true, value };
}

function formatPath(path: string): string {
    if (!path) return "arguments";
    return path;
}

function validateEnum(
    path: string,
    value: unknown,
    enumValues: unknown[] | undefined,
    errors: string[],
): void {
    if (!Array.isArray(enumValues)) return;
    if (enumValues.some((allowed) => allowed === value)) return;
    errors.push(`Invalid value for '${formatPath(path)}'. Expected one of: ${enumValues.join(", ")}.`);
}

function validateProperty(
    propertySchema: ToolSchemaProperty,
    value: unknown,
    path: string,
    errors: string[],
): unknown {
    const expectedType = propertySchema.type;
    let normalized = value;

    if (expectedType) {
        const coerced = coercePrimitive(expectedType, value);
        if (!coerced.ok) {
            errors.push(`Invalid type for '${formatPath(path)}'. Expected '${expectedType}'.`);
            return value;
        }
        normalized = coerced.value;
    }

    validateEnum(path, normalized, propertySchema.enum, errors);

    if (expectedType === "array" && Array.isArray(normalized) && propertySchema.items) {
        const itemSchema = asRecord(propertySchema.items);
        if (itemSchema && typeof itemSchema.type === "string") {
            return normalized.map((item, index) => {
                const nestedSchema = itemSchema as ToolSchemaProperty;
                return validateProperty(nestedSchema, item, `${path}[${index}]`, errors);
            });
        }
        return normalized;
    }

    if (expectedType === "object" && isRecord(normalized) && propertySchema.properties) {
        const nestedProperties = asRecord(propertySchema.properties) ?? {};
        const nestedRequired = Array.isArray(propertySchema.required) ? propertySchema.required : [];
        const normalizedNested: Record<string, unknown> = { ...normalized };

        for (const requiredField of nestedRequired) {
            if (!(requiredField in normalizedNested)) {
                const nestedPath = path ? `${path}.${requiredField}` : requiredField;
                errors.push(`Missing required argument '${formatPath(nestedPath)}'.`);
            }
        }

        for (const [nestedField, nestedSchemaUnknown] of Object.entries(nestedProperties)) {
            if (!(nestedField in normalizedNested)) continue;
            const nestedSchema = asRecord(nestedSchemaUnknown) as ToolSchemaProperty | null;
            if (!nestedSchema) continue;
            const nestedPath = path ? `${path}.${nestedField}` : nestedField;
            normalizedNested[nestedField] = validateProperty(
                nestedSchema,
                normalizedNested[nestedField],
                nestedPath,
                errors,
            );
        }

        return normalizedNested;
    }

    return normalized;
}

export interface ToolValidationResult {
    ok: boolean;
    errors: string[];
    normalizedArgs?: Record<string, unknown>;
}

export function validateToolArgs(
    schema: ToolInputSchema,
    args: unknown,
): ToolValidationResult {
    if (!isRecord(args)) {
        return { ok: false, errors: ["Arguments must be an object."] };
    }

    const required = schema.required ?? [];
    const errors: string[] = [];
    const normalizedArgs: Record<string, unknown> = { ...args };

    for (const field of required) {
        if (!(field in normalizedArgs)) {
            errors.push(`Missing required argument '${field}'.`);
        }
    }

    if (schema.additionalProperties === false) {
        const allowed = new Set(Object.keys(schema.properties));
        for (const key of Object.keys(normalizedArgs)) {
            if (!allowed.has(key)) {
                errors.push(`Unexpected argument '${key}'.`);
            }
        }
    }

    for (const [field, fieldSchema] of Object.entries(schema.properties)) {
        if (!(field in normalizedArgs)) continue;
        normalizedArgs[field] = validateProperty(fieldSchema, normalizedArgs[field], field, errors);
    }

    return {
        ok: errors.length === 0,
        errors,
        normalizedArgs,
    };
}
