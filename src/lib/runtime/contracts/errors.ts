export type RuntimeErrorCode =
    | "invalid_request"
    | "unauthorized"
    | "forbidden"
    | "not_found"
    | "conflict"
    | "timeout"
    | "unavailable"
    | "dependency_failed"
    | "internal";

export interface RuntimeErrorOptions {
    statusCode?: number;
    retryable?: boolean;
    details?: Record<string, unknown>;
    cause?: unknown;
}

const DEFAULT_STATUS_BY_CODE: Record<RuntimeErrorCode, number> = {
    invalid_request: 400,
    unauthorized: 401,
    forbidden: 403,
    not_found: 404,
    conflict: 409,
    timeout: 408,
    unavailable: 503,
    dependency_failed: 502,
    internal: 500,
};

export class RuntimeError extends Error {
    readonly code: RuntimeErrorCode;
    readonly statusCode: number;
    readonly retryable: boolean;
    readonly details?: Record<string, unknown>;
    readonly cause?: unknown;

    constructor(code: RuntimeErrorCode, message: string, options?: RuntimeErrorOptions) {
        super(message);
        this.name = "RuntimeError";
        this.code = code;
        this.statusCode = options?.statusCode ?? DEFAULT_STATUS_BY_CODE[code];
        this.retryable = options?.retryable ?? (code === "timeout" || code === "unavailable");
        this.details = options?.details;
        this.cause = options?.cause;
    }
}

export function toRuntimeError(
    input: unknown,
    fallbackCode: RuntimeErrorCode = "internal",
    fallbackMessage = "Runtime operation failed.",
): RuntimeError {
    if (input instanceof RuntimeError) {
        return input;
    }
    if (input instanceof Error) {
        return new RuntimeError(fallbackCode, input.message || fallbackMessage, { cause: input });
    }
    if (typeof input === "string" && input.trim().length > 0) {
        return new RuntimeError(fallbackCode, input.trim());
    }
    return new RuntimeError(fallbackCode, fallbackMessage, { cause: input });
}

