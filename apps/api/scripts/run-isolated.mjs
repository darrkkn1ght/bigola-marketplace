import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APPROVED_NEON_POOLED_HOST = "ep-round-meadow-bcpljhm1-pooler.c-16.us-east-1.aws.neon.tech";
const APPROVED_NEON_DIRECT_HOST = "ep-round-meadow-bcpljhm1.c-16.us-east-1.aws.neon.tech";
const APPROVED_REDIS_HOST = "megasteady-box-silent-86666.db.redis.io";
const APPROVED_REDIS_PORT = "12423";
const APPROVED_QUEUE_PREFIX = "bigola_test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(__dirname, "..");
const envTestPath = path.join(apiDir, ".env.test");

function parseEnvFile(content) {
  const out = {};
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

function parseUrlSafe(raw, label) {
  if (!raw || raw.includes("REPLACE_WITH_")) {
    throw new Error(`Isolated guard: ${label} is missing or still set to a placeholder.`);
  }
  try {
    return new URL(raw);
  } catch {
    throw new Error(`Isolated guard: ${label} is not a valid URL.`);
  }
}

if (!fs.existsSync(envTestPath)) {
  throw new Error(`Isolated guard: missing ${envTestPath}.`);
}

const envMap = parseEnvFile(fs.readFileSync(envTestPath, "utf8"));

if (envMap.NODE_ENV === "production") {
  throw new Error("Isolated guard: refusing to run with NODE_ENV=production.");
}
if (envMap.BIGOLA_TEST_ISOLATION !== "1") {
  throw new Error("Isolated guard: BIGOLA_TEST_ISOLATION=1 is required.");
}
if (envMap.DISBURSEMENT_ENABLED !== "false") {
  throw new Error("Isolated guard: DISBURSEMENT_ENABLED must be false.");
}
if (envMap.QUEUE_PREFIX !== APPROVED_QUEUE_PREFIX) {
  throw new Error(`Isolated guard: QUEUE_PREFIX must be "${APPROVED_QUEUE_PREFIX}".`);
}

const dbUrl = parseUrlSafe(envMap.DATABASE_URL, "DATABASE_URL");
if (dbUrl.hostname !== APPROVED_NEON_POOLED_HOST) {
  throw new Error(`Isolated guard: DATABASE_URL host "${dbUrl.hostname}" is not approved.`);
}

const directUrl = parseUrlSafe(envMap.DIRECT_URL, "DIRECT_URL");
if (directUrl.hostname.includes("-pooler")) {
  throw new Error("Isolated guard: DIRECT_URL must be a direct (non-pooled) endpoint.");
}
if (directUrl.hostname !== APPROVED_NEON_DIRECT_HOST) {
  throw new Error(`Isolated guard: DIRECT_URL host "${directUrl.hostname}" is not approved.`);
}

const redisUrl = parseUrlSafe(envMap.REDIS_URL, "REDIS_URL");
if (redisUrl.hostname.endsWith("upstash.io")) {
  throw new Error("Isolated guard: refusing to run against Upstash Redis.");
}
if (redisUrl.hostname !== APPROVED_REDIS_HOST || redisUrl.port !== APPROVED_REDIS_PORT) {
  throw new Error(
    `Isolated guard: REDIS_URL target "${redisUrl.hostname}:${redisUrl.port || "(default)"}" is not approved.`
  );
}

const command = process.argv.slice(2).join(" ").trim();
if (!command) {
  throw new Error("Usage: node scripts/run-isolated.mjs <command>");
}

console.log(
  `[isolated-guard] Verified bigola-test PG (${dbUrl.hostname}) + Redis Cloud (${redisUrl.hostname}:${redisUrl.port}), prefix=${envMap.QUEUE_PREFIX}, DISBURSEMENT_ENABLED=${envMap.DISBURSEMENT_ENABLED}`
);

execSync(command, {
  cwd: apiDir,
  stdio: "inherit",
  env: {
    ...process.env,
    ...envMap,
  },
});
