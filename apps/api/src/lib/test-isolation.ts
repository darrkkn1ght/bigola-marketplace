import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, type AppEnv } from "../config/env.js";

const APPROVED_NEON_POOLED_HOST = "ep-round-meadow-bcpljhm1-pooler.c-16.us-east-1.aws.neon.tech";
const APPROVED_NEON_DIRECT_HOST = "ep-round-meadow-bcpljhm1.c-16.us-east-1.aws.neon.tech";
const APPROVED_REDIS_HOST = "megasteady-box-silent-86666.db.redis.io";
const APPROVED_REDIS_PORT = "12423";
const APPROVED_QUEUE_PREFIX = "bigola_test";

function resolveEnvTestPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../.env.test");
}

function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function parseUrlSafe(raw: string | undefined, label: string): URL {
  if (!raw || raw.includes("REPLACE_WITH_")) {
    throw new Error(`Isolated test guard: ${label} is missing or still set to a placeholder.`);
  }
  try {
    return new URL(raw);
  } catch {
    throw new Error(`Isolated test guard: ${label} is not a valid URL.`);
  }
}

export function assertIsolatedTestConfig(envMap: Record<string, string | undefined>): void {
  if (envMap.NODE_ENV === "production") {
    throw new Error("Isolated test guard: refusing to run with NODE_ENV=production.");
  }
  if (envMap.BIGOLA_TEST_ISOLATION !== "1") {
    throw new Error("Isolated test guard: BIGOLA_TEST_ISOLATION=1 is required.");
  }
  if (envMap.DISBURSEMENT_ENABLED !== "false") {
    throw new Error("Isolated test guard: DISBURSEMENT_ENABLED must be explicitly set to false.");
  }
  if (envMap.QUEUE_PREFIX !== APPROVED_QUEUE_PREFIX) {
    throw new Error(`Isolated test guard: QUEUE_PREFIX must be "${APPROVED_QUEUE_PREFIX}".`);
  }

  const dbUrl = parseUrlSafe(envMap.DATABASE_URL, "DATABASE_URL");
  if (dbUrl.hostname !== APPROVED_NEON_POOLED_HOST) {
    throw new Error(
      `Isolated test guard: DATABASE_URL host "${dbUrl.hostname}" is not the approved bigola-test pooled host.`
    );
  }

  const directUrl = parseUrlSafe(envMap.DIRECT_URL, "DIRECT_URL");
  if (directUrl.hostname.includes("-pooler")) {
    throw new Error("Isolated test guard: DIRECT_URL must be a direct (non-pooled) endpoint.");
  }
  if (directUrl.hostname !== APPROVED_NEON_DIRECT_HOST) {
    throw new Error(
      `Isolated test guard: DIRECT_URL host "${directUrl.hostname}" is not the approved bigola-test direct host.`
    );
  }

  const redisUrl = parseUrlSafe(envMap.REDIS_URL, "REDIS_URL");
  if (redisUrl.hostname.endsWith("upstash.io")) {
    throw new Error("Isolated test guard: refusing to run against an Upstash Redis endpoint.");
  }
  if (redisUrl.hostname !== APPROVED_REDIS_HOST || redisUrl.port !== APPROVED_REDIS_PORT) {
    throw new Error(
      `Isolated test guard: REDIS_URL target "${redisUrl.hostname}:${redisUrl.port || "(default)"}" does not match the approved Redis Cloud test database.`
    );
  }
}

/**
 * Explicitly loads `apps/api/.env.test`, validates all isolation guards,
 * applies the isolated values to `process.env` (for PrismaClient), and returns AppEnv.
 */
export function loadIsolatedTestEnv(): AppEnv {
  const envTestPath = resolveEnvTestPath();
  if (!fs.existsSync(envTestPath)) {
    throw new Error(`Isolated test guard: missing ${envTestPath}.`);
  }

  const parsed = parseEnvFile(fs.readFileSync(envTestPath, "utf8"));
  assertIsolatedTestConfig(parsed);

  for (const [key, value] of Object.entries(parsed)) {
    process.env[key] = value;
  }

  return loadEnv(parsed);
}
