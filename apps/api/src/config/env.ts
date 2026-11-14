import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default("0.0.0.0"),
  WEB_BASE_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1).default("postgresql://bigola:dev@localhost:5432/bigola_marketplace?schema=public"),
  DIRECT_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().optional(),
  QUEUE_PREFIX: z.string().default("bigola_mp"),
  SESSION_SECRET: z.string().min(32).default("dev_only_session_secret_replace_in_production_32chars"),
  ENCRYPTION_KEY_HEX: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "ENCRYPTION_KEY_HEX must be a 64-character hex string (32 bytes)")
    .default("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24),
  OWNER_REQUIRE_2FA: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  DISBURSEMENT_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): AppEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }
  if (
    parsed.data.NODE_ENV === "production" &&
    (parsed.data.SESSION_SECRET.startsWith("dev_only_") ||
      parsed.data.ENCRYPTION_KEY_HEX.startsWith("0123456789abcdef"))
  ) {
    throw new Error("Production environment cannot use default development secrets.");
  }
  return parsed.data;
}

