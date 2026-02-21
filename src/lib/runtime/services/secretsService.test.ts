import { describe, expect, it } from "vitest";
import {
    buildSecretValuesFromRecord,
    createSecretsRedactor,
    replaceSecretPlaceholdersInArgs,
} from "@/lib/runtime/services/secretsService";

describe("secretsService", () => {
    it("masks known secret values and token patterns", () => {
        const secrets = buildSecretValuesFromRecord({
            groq: "gsk_live_1234567890",
            openai: "sk-secret-value",
        });
        const redactor = createSecretsRedactor(secrets);
        const masked = redactor.maskText(
            "Authorization: Bearer sk-secret-value; api_key=gsk_live_1234567890",
        );
        expect(masked).not.toContain("sk-secret-value");
        expect(masked).not.toContain("gsk_live_1234567890");
        expect(masked).toContain("[REDACTED]");
    });

    it("replaces secret placeholders recursively", () => {
        const payload = {
            cmd: "echo {{secret:GROQ_API_KEY}}",
            nested: {
                token: "{{secret:openai_api_key}}",
            },
            args: ["--key", "{{secret:MISSING_KEY}}"],
        };
        const resolved = replaceSecretPlaceholdersInArgs(payload, {
            GROQ_API_KEY: "gsk_test",
            OPENAI_API_KEY: "sk-openai",
        });
        expect(resolved.cmd).toContain("gsk_test");
        expect(resolved.nested.token).toBe("sk-openai");
        expect(resolved.args[1]).toBe("[REDACTED]");
    });
});
