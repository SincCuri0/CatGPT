import { RuntimeError, RuntimeErrorCode, toRuntimeError } from "@/lib/runtime/contracts/errors";

export interface RuntimeOk<T> {
    ok: true;
    value: T;
}

export interface RuntimeErr {
    ok: false;
    error: RuntimeError;
}

export type RuntimeResult<T> = RuntimeOk<T> | RuntimeErr;

export function ok<T>(value: T): RuntimeOk<T> {
    return { ok: true, value };
}

export function err(
    input: unknown,
    fallbackCode: RuntimeErrorCode = "internal",
    fallbackMessage = "Runtime operation failed.",
): RuntimeErr {
    return {
        ok: false,
        error: toRuntimeError(input, fallbackCode, fallbackMessage),
    };
}

export async function attempt<T>(
    operation: () => Promise<T> | T,
    fallbackCode: RuntimeErrorCode = "internal",
    fallbackMessage = "Runtime operation failed.",
): Promise<RuntimeResult<T>> {
    try {
        const value = await operation();
        return ok(value);
    } catch (error) {
        return err(error, fallbackCode, fallbackMessage);
    }
}

export function unwrapOrThrow<T>(result: RuntimeResult<T>): T {
    if (!result.ok) throw result.error;
    return result.value;
}

