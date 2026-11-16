import { normalizeLagoslifeUsername } from "@bigola/shared";
import { decryptSensitiveValue, encryptSensitiveValue } from "../lib/crypto.js";

const DEFAULT_BASE_URL = "https://lagoslife.app";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

/**
 * Maximum single LagosLife transfer chunk (100B), preserved from MoneySender `MAX_TRANSFER_CHUNK` (server.js:12).
 */
export const MAX_LAGOSLIFE_TRANSFER_CHUNK = 100_000_000_000n;

/**
 * Per-account cooldown between LagosLife `/api/send` transfers (30.5s), preserved from MoneySender `SEND_COOLDOWN_MS` (server.js:13).
 */
export const LAGOSLIFE_SEND_COOLDOWN_MS = 30_500;

export type LagosLifeSendOutcome =
  | "SUCCEEDED"
  | "RATE_LIMITED"
  | "PIN_REQUIRED"
  | "TWO_FACTOR_REQUIRED"
  | "SESSION_EXPIRED"
  | "DEFINITIVE_FAILURE"
  | "UNCERTAIN";

export interface LagosLifeSendChunkResult {
  outcome: LagosLifeSendOutcome;
  status: number;
  message: string;
  retryAfterMs?: number;
  rawData?: Record<string, unknown>;
}

/**
 * Parses rate-limit wait duration from LagosLife 429 error text, ported from MoneySender `recordRateLimitHit` (server.js:108-128).
 */
export function parseRateLimitWaitMs(errorText: string): number {
  let waitMs = LAGOSLIFE_SEND_COOLDOWN_MS;
  const text = String(errorText || "");
  const secMatch = text.match(/(\d+)\s*(?:s|sec|second)/i);
  const minMatch = text.match(/(\d+)\s*(?:m|min|minute)/i);
  if (minMatch) {
    waitMs = parseInt(minMatch[1]!, 10) * 60_000 + 2000;
  } else if (secMatch) {
    waitMs = parseInt(secMatch[1]!, 10) * 1000 + 1500;
  }
  return Math.max(5000, waitMs);
}

/**
 * Known static LagosLife usernames ported from MoneySender `USERNAME_MAP` (server.js:311-326).
 */
export const KNOWN_LAGOSLIFE_USERNAMES: Record<string, string> = {
  blaqsebastian: "7785cae4f157450490d5",
  sebastian: "7785cae4f157450490d5",
  milespete: "bc745837935d45efbf47",
  miles: "bc745837935d45efbf47",
  princedavid: "7e791760cd644f13ba5a",
  mr_who: "d4f4aed94d6e491989cf",
  lldc: "802ef46ea4eb4b1b8b47",
  kvngdre: "1ab3a45045544574afe8",
  dre: "1ab3a45045544574afe8",
  bigola2823: "6e3c4bdaac6f4765ba52",
  mr_ace: "6e3c4bdaac6f4765ba52",
  _iamking_: "7b17dab5715d43c1b042",
  iamking: "7b17dab5715d43c1b042",
  annie05: "156cda27568c4876b9ec",
};

export interface LagosLifeIdentity {
  uid: string;
  username: string;
  name: string | null;
}

export interface LagosLifeAccountDataResult {
  ok: boolean;
  status: number;
  money: bigint | null;
  name: string | null;
  ownerUid: string | null;
  error?: string;
}

export interface LagosLifeResolvedPlayer {
  id: string;
  username: string;
  name: string | null;
  avatar?: unknown;
}

export interface StoredSessionBundle {
  cookie: string;
  uid: string;
  username: string;
  simName: string | null;
  connectedAt: string;
  verifiedAt: string;
  transactionPin?: string | null;
  pinUpdatedAt?: string | null;
}

export interface SafeSessionMetadata {
  connected: boolean;
  uid: string | null;
  username: string | null;
  simName: string | null;
  connectedAt: string | null;
  verifiedAt: string | null;
  hasPin: boolean;
  pinUpdatedAt: string | null;
}

export type LagosLifeLoginOutcome =
  | {
      status: "AUTHENTICATED";
      cookie: string;
      identity: LagosLifeIdentity;
      accountData: LagosLifeAccountDataResult;
    }
  | {
      status: "TWO_FACTOR_REQUIRED";
      challenge: string;
      method: string;
      to: string | null;
      message: string;
      interimCookies: string;
    };

export class LagosLifeError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "LagosLifeError";
  }
}

export type FetchLike = typeof fetch;

/**
 * Merges incoming `Set-Cookie` headers into an existing cookie string.
 * Ported directly from MoneySender `mergeCookies()` (server.js:159-178).
 */
export function mergeCookies(baseCookie: string, setCookieHeaders: string[]): string {
  if (!setCookieHeaders || setCookieHeaders.length === 0) return baseCookie.trim();
  const cookieMap = new Map<string, string>();
  if (baseCookie) {
    baseCookie.split(";").forEach((part) => {
      const idx = part.indexOf("=");
      if (idx !== -1) {
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k) cookieMap.set(k, v);
      }
    });
  }
  for (const c of setCookieHeaders) {
    const raw = c.split(";")[0] ?? "";
    const idx = raw.indexOf("=");
    if (idx !== -1) {
      const k = raw.slice(0, idx).trim();
      const v = raw.slice(idx + 1).trim();
      if (k) cookieMap.set(k, v);
    }
  }
  return Array.from(cookieMap.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export function extractSetCookieHeaders(headers: Headers): string[] {
  const anyHeaders = headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") {
    return anyHeaders.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

/**
 * Extracts identity fallback from a signed `ll_pass` cookie if `/api/auth/me` omits fields.
 * Ported from MoneySender `getAccountCooldownKey()` (server.js:77-91).
 */
export function parseIdentityFromCookie(cookie: string): Partial<LagosLifeIdentity> {
  if (!cookie) return {};
  try {
    const passMatch = String(cookie).match(/ll_pass=([^;]+)/);
    if (passMatch && passMatch[1]) {
      const payloadPart = passMatch[1].split(".")[0] ?? "";
      const decoded = Buffer.from(payloadPart, "base64").toString("utf8");
      const parsed = JSON.parse(decoded) as { i?: unknown; u?: unknown; n?: unknown };
      return {
        uid: typeof parsed.i === "string" ? parsed.i : undefined,
        username: typeof parsed.u === "string" ? parsed.u : undefined,
        name: typeof parsed.n === "string" ? parsed.n : null,
      };
    }
  } catch {
    // Ignore malformed cookie payload
  }
  return {};
}

export function encodeEncryptedSessionBundle(
  bundle: StoredSessionBundle,
  encryptionKeyHex: string
): string {
  return encryptSensitiveValue(JSON.stringify(bundle), encryptionKeyHex);
}

export function decodeEncryptedSessionBundle(
  encryptedBundle: string | null | undefined,
  encryptionKeyHex: string
): StoredSessionBundle | null {
  if (!encryptedBundle) return null;
  try {
    const raw = decryptSensitiveValue(encryptedBundle, encryptionKeyHex);
    const parsed = JSON.parse(raw) as Partial<StoredSessionBundle>;
    if (!parsed || typeof parsed.cookie !== "string" || !parsed.cookie.trim()) {
      return null;
    }
    return {
      cookie: parsed.cookie.trim(),
      uid: typeof parsed.uid === "string" ? parsed.uid : "",
      username: typeof parsed.username === "string" ? parsed.username : "",
      simName: typeof parsed.simName === "string" ? parsed.simName : null,
      connectedAt:
        typeof parsed.connectedAt === "string" ? parsed.connectedAt : new Date().toISOString(),
      verifiedAt:
        typeof parsed.verifiedAt === "string" ? parsed.verifiedAt : new Date().toISOString(),
      transactionPin:
        typeof parsed.transactionPin === "string" && parsed.transactionPin.trim()
          ? parsed.transactionPin.trim()
          : null,
      pinUpdatedAt:
        typeof parsed.pinUpdatedAt === "string" ? parsed.pinUpdatedAt : null,
    };
  } catch {
    return null;
  }
}

export function getSafeSessionMetadata(
  encryptedBundle: string | null | undefined,
  encryptionKeyHex: string
): SafeSessionMetadata {
  const decoded = decodeEncryptedSessionBundle(encryptedBundle, encryptionKeyHex);
  if (!decoded) {
    return {
      connected: false,
      uid: null,
      username: null,
      simName: null,
      connectedAt: null,
      verifiedAt: null,
      hasPin: false,
      pinUpdatedAt: null,
    };
  }
  return {
    connected: true,
    uid: decoded.uid || null,
    username: decoded.username || null,
    simName: decoded.simName ?? null,
    connectedAt: decoded.connectedAt,
    verifiedAt: decoded.verifiedAt,
    hasPin: Boolean(decoded.transactionPin && decoded.transactionPin.trim()),
    pinUpdatedAt: decoded.pinUpdatedAt ?? null,
  };
}

function parseObservedMoneyToBigInt(rawMoney: unknown): bigint | null {
  if (typeof rawMoney === "bigint") {
    return rawMoney >= 0n ? rawMoney : 0n;
  }
  if (typeof rawMoney === "number") {
    if (!Number.isFinite(rawMoney)) return null;
    return BigInt(Math.max(0, Math.trunc(rawMoney)));
  }
  if (typeof rawMoney === "string" && rawMoney.trim()) {
    const cleaned = rawMoney.trim().split(".")[0]?.replace(/[^0-9-]/g, "") ?? "";
    if (!cleaned) return null;
    try {
      const val = BigInt(cleaned);
      return val >= 0n ? val : 0n;
    } catch {
      return null;
    }
  }
  return null;
}

interface PendingTwoFactorChallengeRecord {
  slotCode: string;
  username: string;
  interimCookies: string;
  createdAt: number;
}

const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class LagosLifeAdapter {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly pendingChallenges = new Map<string, PendingTwoFactorChallengeRecord>();
  private readonly resolvedContactsCache = new Map<string, LagosLifeResolvedPlayer>();

  constructor(opts?: { baseUrl?: string; fetchImpl?: FetchLike }) {
    this.baseUrl = (opts?.baseUrl ?? process.env.LAGOSLIFE_BASE_URL ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      ""
    );
    this.fetchImpl = opts?.fetchImpl ?? fetch;
  }

  private pruneExpiredChallenges(now = Date.now()) {
    for (const [challengeId, record] of this.pendingChallenges.entries()) {
      if (now - record.createdAt > CHALLENGE_TTL_MS) {
        this.pendingChallenges.delete(challengeId);
      }
    }
  }

  /**
   * Verifies the authenticated LagosLife user via `GET /api/auth/me`.
   * Ported from MoneySender `server.js:1582-1587` and `server.js:1719-1725`.
   */
  async verifySessionIdentity(cookie: string): Promise<LagosLifeIdentity> {
    const cleanCookie = cookie.trim();
    if (!cleanCookie) {
      throw new LagosLifeError(400, "EMPTY_SESSION_COOKIE", "Session cookie is required.");
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/auth/me`, {
        method: "GET",
        headers: {
          accept: "application/json",
          cookie: cleanCookie,
          "user-agent": DEFAULT_USER_AGENT,
        },
      });
    } catch {
      throw new LagosLifeError(
        502,
        "LAGOSLIFE_UNREACHABLE",
        "Could not reach LagosLife to verify session identity."
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new LagosLifeError(
        401,
        "LAGOSLIFE_SESSION_EXPIRED",
        "LagosLife session is invalid or has expired."
      );
    }

    const data = (await res.json().catch(() => ({}))) as {
      user?: { id?: unknown; username?: unknown; name?: unknown };
      error?: unknown;
    };

    const cookieIdentity = parseIdentityFromCookie(cleanCookie);
    const uid =
      typeof data.user?.id === "string" && data.user.id.trim()
        ? data.user.id.trim()
        : (cookieIdentity.uid ?? "");
    const username =
      typeof data.user?.username === "string" && data.user.username.trim()
        ? normalizeLagoslifeUsername(data.user.username)
        : cookieIdentity.username
          ? normalizeLagoslifeUsername(cookieIdentity.username)
          : "";
    const name =
      typeof data.user?.name === "string" && data.user.name.trim()
        ? data.user.name.trim()
        : (cookieIdentity.name ?? null);

    if (!res.ok || !username) {
      throw new LagosLifeError(
        401,
        "LAGOSLIFE_SESSION_INVALID",
        "Invalid or expired LagosLife session cookie."
      );
    }

    return {
      uid: uid || KNOWN_LAGOSLIFE_USERNAMES[username] || "",
      username,
      name,
    };
  }

  /**
   * Fetches live account balance and character info via `GET /api/save`.
   * Ported from MoneySender `fetchAccountData(cookie)` (server.js:475-492).
   */
  async fetchAccountData(cookie: string): Promise<LagosLifeAccountDataResult> {
    const cleanCookie = cookie.trim();
    if (!cleanCookie) {
      return {
        ok: false,
        status: 400,
        money: null,
        name: null,
        ownerUid: null,
        error: "Missing session cookie.",
      };
    }

    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/save`, {
        method: "GET",
        headers: {
          accept: "application/json",
          cookie: cleanCookie,
          "user-agent": DEFAULT_USER_AGENT,
        },
      });

      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          money: null,
          name: null,
          ownerUid: null,
          error: res.status === 401 ? "Session expired (401)" : `HTTP ${res.status}`,
        };
      }

      const data = (await res.json().catch(() => ({}))) as {
        game?: {
          money?: unknown;
          sim?: { name?: unknown };
          owner?: unknown;
        };
        snap?: { cash?: unknown };
        cash?: unknown;
        user?: { id?: unknown };
      };

      const rawMoney = data.game?.money ?? data.snap?.cash ?? data.cash ?? null;
      const money = parseObservedMoneyToBigInt(rawMoney);
      const simName =
        typeof data.game?.sim?.name === "string"
          ? data.game.sim.name
          : typeof (data.game?.owner as { name?: unknown } | undefined)?.name === "string"
            ? ((data.game?.owner as { name: string }).name ?? null)
            : null;
      const ownerUid =
        typeof data.game?.owner === "string"
          ? data.game.owner
          : typeof data.user?.id === "string"
            ? data.user.id
            : null;

      if (money === null) {
        return {
          ok: false,
          status: 502,
          money: null,
          name: simName,
          ownerUid,
          error: "LagosLife /api/save response did not include a valid numeric balance.",
        };
      }

      return {
        ok: true,
        status: res.status,
        money,
        name: simName,
        ownerUid,
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        money: null,
        name: null,
        ownerUid: null,
        error: (err as Error).message || "Network error contacting LagosLife /api/save",
      };
    }
  }

  /**
   * Logs into a LagosLife account with username & password via `POST /api/auth/login`.
   * Supports 2FA challenge detection (`code === "two_factor"` or `challenge`).
   * Ported from MoneySender `POST /api/client/login` (server.js:1532-1608).
   */
  async loginWithCredentials(input: {
    slotCode: string;
    username: string;
    password: string;
  }): Promise<LagosLifeLoginOutcome> {
    this.pruneExpiredChallenges();
    const cleanUser = normalizeLagoslifeUsername(input.username);
    if (!cleanUser || !input.password) {
      throw new LagosLifeError(
        400,
        "INVALID_CREDENTIALS_INPUT",
        "LagosLife username and password are required."
      );
    }

    let loginRes: Response;
    try {
      loginRes = await this.fetchImpl(`${this.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          origin: this.baseUrl,
          referer: `${this.baseUrl}/`,
          "user-agent": DEFAULT_USER_AGENT,
        },
        body: JSON.stringify({
          username: cleanUser,
          password: input.password,
        }),
      });
    } catch {
      throw new LagosLifeError(
        502,
        "LAGOSLIFE_UNREACHABLE",
        "Could not connect to LagosLife login endpoint."
      );
    }

    const loginData = (await loginRes.json().catch(() => ({}))) as {
      code?: unknown;
      challenge?: unknown;
      method?: unknown;
      to?: unknown;
      error?: unknown;
    };

    const setCookies = extractSetCookieHeaders(loginRes.headers);
    const interimCookies = mergeCookies("", setCookies);

    // Check for Two-Step Login (2FA) challenge
    if (loginData.code === "two_factor" || typeof loginData.challenge === "string") {
      const challenge =
        typeof loginData.challenge === "string" && loginData.challenge.trim()
          ? loginData.challenge.trim()
          : "";
      if (!challenge) {
        throw new LagosLifeError(
          502,
          "INVALID_2FA_CHALLENGE",
          "LagosLife requested two-factor authentication without a challenge token."
        );
      }

      this.pendingChallenges.set(challenge, {
        slotCode: input.slotCode,
        username: cleanUser,
        interimCookies,
        createdAt: Date.now(),
      });

      return {
        status: "TWO_FACTOR_REQUIRED",
        challenge,
        method: typeof loginData.method === "string" ? loginData.method : "app",
        to: typeof loginData.to === "string" ? loginData.to : null,
        message:
          typeof loginData.error === "string"
            ? loginData.error
            : "Two-step login verification code required.",
        interimCookies,
      };
    }

    if (!loginRes.ok) {
      const upstreamError =
        typeof loginData.error === "string" && loginData.error.trim()
          ? loginData.error.trim()
          : "Login rejected by LagosLife. Please verify credentials.";
      throw new LagosLifeError(
        loginRes.status === 429 ? 429 : 401,
        loginRes.status === 429 ? "LAGOSLIFE_RATE_LIMITED" : "LAGOSLIFE_LOGIN_REJECTED",
        upstreamError
      );
    }

    if (!interimCookies) {
      throw new LagosLifeError(
        401,
        "NO_SESSION_COOKIES",
        "LagosLife did not return any session cookies."
      );
    }

    const identity = await this.verifySessionIdentity(interimCookies);
    const accountData = await this.fetchAccountData(interimCookies);
    if (!accountData.ok) {
      throw new LagosLifeError(
        502,
        "LAGOSLIFE_SAVE_FETCH_FAILED",
        accountData.error ?? "Failed to retrieve live account data from LagosLife /api/save."
      );
    }

    return {
      status: "AUTHENTICATED",
      cookie: interimCookies,
      identity: {
        uid: identity.uid || accountData.ownerUid || "",
        username: identity.username || cleanUser,
        name: accountData.name ?? identity.name,
      },
      accountData,
    };
  }

  /**
   * Completes a pending Two-Step (2FA) login challenge via `POST /api/auth/2fa`.
   * Ported from MoneySender `POST /api/client/2fa` (server.js:1611-1683).
   */
  async completeLoginTwoFactor(input: {
    slotCode: string;
    challenge: string;
    code: string;
  }): Promise<{
    cookie: string;
    identity: LagosLifeIdentity;
    accountData: LagosLifeAccountDataResult;
  }> {
    this.pruneExpiredChallenges();
    const challenge = input.challenge.trim();
    const cleanCode = input.code.trim().toUpperCase();
    if (!challenge || !cleanCode) {
      throw new LagosLifeError(
        400,
        "INVALID_2FA_INPUT",
        "Challenge and verification code are required."
      );
    }

    const pending = this.pendingChallenges.get(challenge);
    if (pending && pending.slotCode !== input.slotCode) {
      throw new LagosLifeError(
        409,
        "CHALLENGE_SLOT_MISMATCH",
        `This 2FA challenge belongs to slot ${pending.slotCode}, not ${input.slotCode}.`
      );
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      origin: this.baseUrl,
      referer: `${this.baseUrl}/`,
      "user-agent": DEFAULT_USER_AGENT,
    };
    if (pending?.interimCookies) {
      headers.cookie = pending.interimCookies;
    }

    let twoFaRes: Response;
    try {
      twoFaRes = await this.fetchImpl(`${this.baseUrl}/api/auth/2fa`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "login",
          challenge,
          code: cleanCode,
        }),
      });
    } catch {
      throw new LagosLifeError(
        502,
        "LAGOSLIFE_UNREACHABLE",
        "Could not connect to LagosLife 2FA endpoint."
      );
    }

    const twoFaData = (await twoFaRes.json().catch(() => ({}))) as { error?: unknown };
    if (!twoFaRes.ok) {
      const msg =
        typeof twoFaData.error === "string" && twoFaData.error.trim()
          ? twoFaData.error.trim()
          : "Invalid 2FA verification code.";
      throw new LagosLifeError(
        twoFaRes.status === 429 ? 429 : 401,
        "LAGOSLIFE_2FA_REJECTED",
        msg
      );
    }

    const newSetCookies = extractSetCookieHeaders(twoFaRes.headers);
    const mergedCookie = mergeCookies(pending?.interimCookies ?? "", newSetCookies);
    if (!mergedCookie) {
      throw new LagosLifeError(
        401,
        "NO_SESSION_COOKIES",
        "No session cookies received from LagosLife 2FA verification."
      );
    }

    this.pendingChallenges.delete(challenge);

    const identity = await this.verifySessionIdentity(mergedCookie);
    const accountData = await this.fetchAccountData(mergedCookie);
    if (!accountData.ok) {
      throw new LagosLifeError(
        502,
        "LAGOSLIFE_SAVE_FETCH_FAILED",
        accountData.error ?? "Failed to retrieve live account data after 2FA verification."
      );
    }

    return {
      cookie: mergedCookie,
      identity: {
        uid: identity.uid || accountData.ownerUid || "",
        username: identity.username || pending?.username || "",
        name: accountData.name ?? identity.name,
      },
      accountData,
    };
  }

  /**
   * Resends a login 2FA code (when email method is used) via `POST /api/auth/2fa` (`action: "send"`).
   * Ported from MoneySender `POST /api/client/2fa/resend` (server.js:1686-1710).
   */
  async resendLoginTwoFactor(challenge: string): Promise<{ ok: true; to: string | null }> {
    const cleanChallenge = challenge.trim();
    if (!cleanChallenge) {
      throw new LagosLifeError(400, "CHALLENGE_REQUIRED", "2FA challenge token is required.");
    }

    let resendRes: Response;
    try {
      resendRes = await this.fetchImpl(`${this.baseUrl}/api/auth/2fa`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          origin: this.baseUrl,
          referer: `${this.baseUrl}/`,
          "user-agent": DEFAULT_USER_AGENT,
        },
        body: JSON.stringify({ action: "send", challenge: cleanChallenge }),
      });
    } catch {
      throw new LagosLifeError(
        502,
        "LAGOSLIFE_UNREACHABLE",
        "Could not reach LagosLife 2FA resend endpoint."
      );
    }

    const data = (await resendRes.json().catch(() => ({}))) as { to?: unknown; error?: unknown };
    if (!resendRes.ok) {
      throw new LagosLifeError(
        resendRes.status === 429 ? 429 : 400,
        "LAGOSLIFE_2FA_RESEND_FAILED",
        typeof data.error === "string" ? data.error : "Failed to resend 2FA code."
      );
    }

    return {
      ok: true,
      to: typeof data.to === "string" ? data.to : null,
    };
  }

  /**
   * Validates an imported session cookie bundle against `/api/auth/me` and `/api/save`.
   * Ported from MoneySender `POST /api/client/import-cookie` (server.js:1713-1748).
   */
  async validateImportedCookie(cookie: string): Promise<{
    cookie: string;
    identity: LagosLifeIdentity;
    accountData: LagosLifeAccountDataResult;
  }> {
    const normalizedCookie = mergeCookies(cookie.trim(), []);
    if (!normalizedCookie) {
      throw new LagosLifeError(400, "EMPTY_SESSION_COOKIE", "Session cookie string is required.");
    }

    const identity = await this.verifySessionIdentity(normalizedCookie);
    const accountData = await this.fetchAccountData(normalizedCookie);
    if (!accountData.ok) {
      throw new LagosLifeError(
        accountData.status === 401 ? 401 : 502,
        accountData.status === 401 ? "LAGOSLIFE_SESSION_EXPIRED" : "LAGOSLIFE_SAVE_FETCH_FAILED",
        accountData.error ?? "Could not fetch account data from LagosLife /api/save."
      );
    }

    return {
      cookie: normalizedCookie,
      identity: {
        uid: identity.uid || accountData.ownerUid || "",
        username: identity.username,
        name: accountData.name ?? identity.name,
      },
      accountData,
    };
  }

  /**
   * Resolves a LagosLife `@username`, profile URL, or 20-char hex ID to `{ id, username, name }`.
   * Requires exact case-insensitive username match so typos never resolve to the wrong player.
   * Ported from MoneySender `resolveTargetIdAsync()` (server.js:349-470).
   */
  async resolveTargetIdAsync(
    input: string,
    cookie?: string
  ): Promise<LagosLifeResolvedPlayer | null> {
    if (!input) return null;
    const trimmed = String(input)
      .trim()
      .replace(/^\s*\d+[.)]\s+/, "")
      .replace(/^[-*•)("\s']+/, "")
      .replace(/["',\s]+$/, "")
      .trim();

    if (!trimmed) return null;

    // 1. Check URL query parameters (?with=..., ?host=..., ?of=...)
    const urlMatch = trimmed.match(/[?&](?:with|host|of)=([a-f0-9]{16,})/i);
    if (urlMatch?.[1]) {
      const id = urlMatch[1].toLowerCase();
      return { id, username: id, name: null };
    }

    // 2. Check player profile URL
    const profileMatch = trimmed.match(/lagoslife\.app\/.*?([a-f0-9]{16,})/i);
    if (profileMatch?.[1]) {
      const id = profileMatch[1].toLowerCase();
      return { id, username: id, name: null };
    }

    // 3. Check exact 20-character hex ID
    const hexCandidate = trimmed.replace(/^@+/, "");
    if (/^[a-f0-9]{20}$/i.test(hexCandidate)) {
      const id = hexCandidate.toLowerCase();
      return { id, username: id, name: null };
    }

    // 4. Check known static map
    const clean = hexCandidate.toLowerCase();
    if (KNOWN_LAGOSLIFE_USERNAMES[clean]) {
      return {
        id: KNOWN_LAGOSLIFE_USERNAMES[clean]!,
        username: clean,
        name: null,
      };
    }

    // 5. Check in-memory resolved cache
    const cached = this.resolvedContactsCache.get(clean);
    if (cached) {
      return cached;
    }

    // 6. Query LagosLife live endpoints (requires exact username match)
    const searchTerms = [clean];
    const strippedUnderscore = clean.replace(/^_+|_+$/g, "");
    if (strippedUnderscore && strippedUnderscore !== clean) {
      searchTerms.push(strippedUnderscore);
    }

    const reqHeaders: Record<string, string> = {
      accept: "application/json",
      "user-agent": DEFAULT_USER_AGENT,
      ...(cookie ? { cookie } : {}),
    };

    for (const term of searchTerms) {
      try {
        const res = await this.fetchImpl(
          `${this.baseUrl}/api/players?q=${encodeURIComponent(term)}`,
          { headers: reqHeaders }
        );
        if (res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            players?: Array<{ id?: string; username?: string; name?: string; look?: unknown }>;
          };
          const players = Array.isArray(data.players) ? data.players : [];
          const exact = players.find((p) => {
            const u = (p.username ?? "").toLowerCase();
            return u === clean || u === term;
          });
          if (exact?.id && exact.username) {
            const resolved: LagosLifeResolvedPlayer = {
              id: exact.id,
              username: exact.username,
              name: exact.name ?? null,
              avatar: exact.look,
            };
            this.resolvedContactsCache.set(clean, resolved);
            return resolved;
          }
        }
      } catch {
        // Continue to fallback endpoint
      }

      try {
        const resBills = await this.fetchImpl(
          `${this.baseUrl}/api/bills?people=1&q=${encodeURIComponent(term)}`,
          { headers: reqHeaders }
        );
        if (resBills.ok) {
          const bData = (await resBills.json().catch(() => ({}))) as {
            people?: Array<{ id?: string; username?: string; name?: string; look?: unknown }>;
            players?: Array<{ id?: string; username?: string; name?: string; look?: unknown }>;
            users?: Array<{ id?: string; username?: string; name?: string; look?: unknown }>;
          };
          const people = bData.people ?? bData.players ?? bData.users ?? [];
          const exact = people.find((p) => {
            const u = (p.username ?? "").toLowerCase();
            return u === clean || u === term;
          });
          if (exact?.id && exact.username) {
            const resolved: LagosLifeResolvedPlayer = {
              id: exact.id,
              username: exact.username,
              name: exact.name ?? null,
              avatar: exact.look,
            };
            this.resolvedContactsCache.set(clean, resolved);
            return resolved;
          }
        }
      } catch {
        // Continue to next fallback
      }
    }

    // 7. Check active parties list (/api/parties) and current save state (/api/save)
    try {
      const pRes = await this.fetchImpl(`${this.baseUrl}/api/parties`, { headers: reqHeaders });
      if (pRes.ok) {
        const pData = (await pRes.json().catch(() => ({}))) as {
          parties?: Array<{ id?: string; host?: string; username?: string; name?: string }>;
        };
        const parties = Array.isArray(pData.parties) ? pData.parties : [];
        const found = parties.find(
          (p) =>
            (p.username ?? "").toLowerCase() === clean ||
            (p.host ?? "").toLowerCase() === clean ||
            (p.id ?? "").toLowerCase() === clean
        );
        const hid = found?.host ?? found?.id;
        if (found && hid) {
          const resolved: LagosLifeResolvedPlayer = {
            id: hid,
            username: found.username ?? clean,
            name: found.name ?? null,
          };
          this.resolvedContactsCache.set(clean, resolved);
          return resolved;
        }
      }
    } catch {
      // Ignore fallback error
    }

    try {
      const sRes = await this.fetchImpl(`${this.baseUrl}/api/save`, { headers: reqHeaders });
      if (sRes.ok) {
        const sData = (await sRes.json().catch(() => ({}))) as {
          players?: Array<{ id?: string; username?: string; name?: string }>;
          guests?: Array<{ id?: string; username?: string; name?: string }>;
          me?: { id?: string; username?: string; name?: string };
        };
        const pool = [
          ...(Array.isArray(sData.players) ? sData.players : []),
          ...(Array.isArray(sData.guests) ? sData.guests : []),
          ...(sData.me ? [sData.me] : []),
        ];
        const found = pool.find(
          (p) => (p.username ?? "").toLowerCase() === clean || (p.id ?? "").toLowerCase() === clean
        );
        if (found?.id) {
          const resolved: LagosLifeResolvedPlayer = {
            id: found.id,
            username: found.username ?? clean,
            name: found.name ?? null,
          };
          this.resolvedContactsCache.set(clean, resolved);
          return resolved;
        }
      }
    } catch {
      // Ignore fallback error
    }

    return null;
  }

  /**
   * Sends a single currency transfer chunk to LagosLife via `POST /api/send`.
   * Ported from MoneySender `sendMoney(cookie, to, amount, key, twoStepCode, pin)` (server.js:494-527).
   *
   * Classification guarantees duplicate-transfer safety:
   * - HTTP 200 -> `SUCCEEDED`
   * - HTTP 429 -> `RATE_LIMITED` (not executed upstream; caller waits `retryAfterMs`)
   * - HTTP 401/403 -> `SESSION_EXPIRED`
   * - HTTP 400/404/422 -> `DEFINITIVE_FAILURE` (rejected before execution)
   * - Network error / timeout (`status: 0`) or HTTP 5xx -> `UNCERTAIN` (caller MUST reconcile via `/api/save` before any retry)
   */
  async sendCurrencyChunk(input: {
    cookie: string;
    targetId: string;
    amount: bigint;
    idempotencyKey: string;
    pin?: string;
    twoStepCode?: string;
  }): Promise<LagosLifeSendChunkResult> {
    if (input.amount <= 0n) {
      throw new LagosLifeError(400, "INVALID_CHUNK_AMOUNT", "Transfer chunk amount must be positive.");
    }
    if (input.amount > MAX_LAGOSLIFE_TRANSFER_CHUNK) {
      throw new LagosLifeError(
        400,
        "CHUNK_EXCEEDS_MAX_LIMIT",
        `Transfer chunk (${input.amount.toString()}) exceeds the 100B maximum chunk limit.`
      );
    }

    const payload: Record<string, unknown> = {
      to: input.targetId,
      amount: Number(input.amount),
    };
    const cleanPin = input.pin ? String(input.pin).trim() : "";
    const cleanTwoStep = input.twoStepCode ? String(input.twoStepCode).trim() : "";
    const effectivePin = cleanPin || cleanTwoStep;
    if (effectivePin) {
      payload.pin = effectivePin;
    }
    if (cleanTwoStep && cleanTwoStep !== cleanPin) {
      payload.code = cleanTwoStep;
      payload.twoStep = cleanTwoStep;
    }

    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/send`, {
        method: "POST",
        headers: {
          accept: "*/*",
          "cache-control": "no-cache",
          pragma: "no-cache",
          "content-type": "application/json",
          origin: this.baseUrl,
          referer: `${this.baseUrl}/`,
          cookie: input.cookie,
          "user-agent": DEFAULT_USER_AGENT,
          "idempotency-key": input.idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      const text = await res.text();
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        data = { raw: text.slice(0, 300) };
      }

      const message =
        typeof data.error === "string"
          ? data.error
          : typeof data.message === "string"
            ? data.message
            : res.status === 200
              ? "Transfer chunk succeeded."
              : `LagosLife /api/send returned HTTP ${res.status}.`;

      if (res.status === 200) {
        return {
          outcome: "SUCCEEDED",
          status: 200,
          message,
          rawData: data,
        };
      }

      if (res.status === 429) {
        return {
          outcome: "RATE_LIMITED",
          status: 429,
          message,
          retryAfterMs: parseRateLimitWaitMs(message),
          rawData: data,
        };
      }

      const errLower = message.toLowerCase();
      if (errLower.includes("pin") || errLower.includes("passcode")) {
        return {
          outcome: "PIN_REQUIRED",
          status: res.status,
          message,
          rawData: data,
        };
      }

      if (
        errLower.includes("two-step") ||
        errLower.includes("two step") ||
        errLower.includes("twofactor") ||
        errLower.includes("two factor") ||
        errLower.includes("2fa") ||
        errLower.includes("verification") ||
        errLower.includes("challenge") ||
        errLower.includes("code required")
      ) {
        return {
          outcome: "TWO_FACTOR_REQUIRED",
          status: res.status,
          message,
          rawData: data,
        };
      }

      if (res.status === 401 || res.status === 403) {
        return {
          outcome: "SESSION_EXPIRED",
          status: res.status,
          message,
          rawData: data,
        };
      }

      if (res.status === 400 || res.status === 404 || res.status === 422) {
        return {
          outcome: "DEFINITIVE_FAILURE",
          status: res.status,
          message,
          rawData: data,
        };
      }

      // HTTP 5xx or unexpected status codes are treated as UNCERTAIN so we never blindly retry
      return {
        outcome: "UNCERTAIN",
        status: res.status,
        message,
        rawData: data,
      };
    } catch (err) {
      return {
        outcome: "UNCERTAIN",
        status: 0,
        message: err instanceof Error ? err.message : "Network error or timeout during /api/send.",
      };
    }
  }
}
