import crypto from "node:crypto";

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) {
    throw new Error("Password must be at least 10 characters long.");
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  return `scrypt$${SCRYPT_COST}$${salt}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") {
    return false;
  }
  const cost = Number(parts[1]);
  const salt = parts[2];
  const expectedHex = parts[3];
  if (!Number.isFinite(cost) || !salt || !expectedHex) {
    return false;
  }

  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, { N: cost }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  const expectedBuf = Buffer.from(expectedHex, "hex");
  if (derived.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(derived, expectedBuf);
}

export function generateOpaqueToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function hashSessionToken(token: string, sessionSecret: string): string {
  return crypto.createHmac("sha256", sessionSecret).update(token).digest("hex");
}

export function encryptSensitiveValue(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSensitiveValue(ciphertext: string, keyHex: string): string {
  const [ivHex, tagHex, dataHex] = ciphertext.split(":");
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error("Malformed encrypted payload.");
  }
  const key = Buffer.from(keyHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

// --- RFC 6238 TOTP Implementation (Base32 secret, SHA-1, 30s step, 6 digits) ---

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(byteLength = 20): string {
  const bytes = crypto.randomBytes(byteLength);
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function decodeBase32(secret: string): Buffer {
  const normalized = secret.replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of normalized) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) {
      throw new Error("Invalid Base32 TOTP secret.");
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpCode(secret: string, timestampMs = Date.now(), stepSeconds = 30): string {
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const key = decodeBase32(secret);
  const hmac = crypto.createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

export function verifyTotpCode(
  secret: string,
  code: string,
  timestampMs = Date.now(),
  windowSteps = 1
): boolean {
  if (!/^\d{6}$/.test(code)) {
    return false;
  }
  const codeBuf = Buffer.from(code, "utf8");
  for (let offset = -windowSteps; offset <= windowSteps; offset++) {
    const candidate = generateTotpCode(secret, timestampMs + offset * 30_000);
    if (crypto.timingSafeEqual(codeBuf, Buffer.from(candidate, "utf8"))) {
      return true;
    }
  }
  return false;
}

export function buildOtpAuthUri(accountEmail: string, secret: string, issuer = "BigOlaMarketplace"): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}

export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString("hex").toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

export function hashRecoveryCode(code: string, sessionSecret: string): string {
  const normalized = code.trim().toUpperCase();
  return crypto.createHmac("sha256", sessionSecret).update(`recovery:${normalized}`).digest("hex");
}

export function consumeRecoveryCode(
  code: string,
  storedHashes: string[],
  sessionSecret: string
): { matched: boolean; remainingHashes: string[] } {
  const candidateHash = hashRecoveryCode(code, sessionSecret);
  const candidateBuf = Buffer.from(candidateHash, "hex");
  let matchedIndex = -1;

  for (let i = 0; i < storedHashes.length; i++) {
    const storedBuf = Buffer.from(storedHashes[i], "hex");
    if (
      storedBuf.length === candidateBuf.length &&
      crypto.timingSafeEqual(candidateBuf, storedBuf)
    ) {
      matchedIndex = i;
      break;
    }
  }

  if (matchedIndex === -1) {
    return { matched: false, remainingHashes: storedHashes };
  }

  return {
    matched: true,
    remainingHashes: storedHashes.filter((_, idx) => idx !== matchedIndex),
  };
}

