import { z } from "zod";

const schema = z.object({
    DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
    DISCORD_CLIENT_ID: z.string().min(1, "DISCORD_CLIENT_ID is required"),
    DISCORD_DEV_GUILD_ID: z.string().optional(),
    OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),
    OLLAMA_MODEL: z.string().default("llama3.2"),
    OLLAMA_FAST_MODEL: z.string().optional(),
    OPENAI_DEFAULT_MODEL: z.string().default("gpt-4o-mini"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    ANALYZE_DEBOUNCE_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),
    DEV_LOCAL_FALLBACK: z
        .union([z.literal("true"), z.literal("false")])
        .optional()
        .default("false")
        .transform((v) => v === "true"),
    CRYPTO_KEY: z.string().refine((v) => Buffer.from(v, "base64").length === 32, {
        message: "CRYPTO_KEY must be 32 bytes encoded as base64",
    }),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function loadEnv(): Env {
    if (cached) return cached;

    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
        throw new Error(`Invalid environment configuration:\n${issues}`);
    }

    cached = parsed.data;
    return cached;
}

export const env = new Proxy({} as Env, {
    get(_target, prop: keyof Env) {
        return loadEnv()[prop];
    },
});
