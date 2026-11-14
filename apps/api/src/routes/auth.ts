import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { UserRole } from "@bigola/shared";
import {
  buildOtpAuthUri,
  consumeRecoveryCode,
  decryptSensitiveValue,
  encryptSensitiveValue,
  generateOpaqueToken,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  hashRecoveryCode,
  hashSessionToken,
  verifyPassword,
  verifyTotpCode,
} from "../lib/crypto.js";
import type { AuditLogger } from "../lib/audit.js";
import type { AuthStore } from "../lib/repositories.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../middleware/auth.js";

const registerSchema = z.object({
  email: z.string().email(),
  phone: z.string().min(7).max(20).optional(),
  password: z.string().min(10).max(128),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const totpCodeSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
});

const recoveryCodeSchema = z.object({
  recoveryCode: z.string().min(8).max(32),
});

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: {
    authStore: AuthStore;
    audit: AuditLogger;
    authenticate: ReturnType<typeof import("../middleware/auth.js").createAuthMiddleware>["authenticate"];
    sessionSecret: string;
    encryptionKeyHex: string;
    sessionTtlHours: number;
    isProd: boolean;
  }
) {
  const authRateLimit = {
    rateLimit: {
      max: 10,
      timeWindow: "1 minute",
    },
  };

  app.post("/api/v1/auth/register", { config: authRateLimit }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid registration payload.", details: parsed.error.flatten() });
    }

    const existing = await deps.authStore.findUserByEmail(parsed.data.email);
    if (existing) {
      return reply.code(409).send({ error: "An account with this email already exists." });
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const user = await deps.authStore.createUser({
      email: parsed.data.email,
      phone: parsed.data.phone ?? null,
      passwordHash,
      role: UserRole.CUSTOMER, // Public registration is strictly CUSTOMER
    });

    await deps.audit.record({
      actorUserId: user.id,
      actionType: "USER_REGISTERED",
      targetEntity: "USER",
      targetId: user.id,
      afterState: { email: user.email, role: user.role },
      ipAddress: request.ip,
    });

    return reply.code(201).send({
      id: user.id,
      email: user.email,
      role: user.role,
    });
  });

  app.post("/api/v1/auth/login", { config: authRateLimit }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid login credentials format." });
    }

    const user = await deps.authStore.findUserByEmail(parsed.data.email);
    if (!user || !user.isActive) {
      return reply.code(401).send({ error: "Invalid email or password." });
    }

    const valid = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!valid) {
      await deps.audit.record({
        actorUserId: user.id,
        actionType: "USER_LOGIN_FAILED",
        targetEntity: "USER",
        targetId: user.id,
        ipAddress: request.ip,
      });
      return reply.code(401).send({ error: "Invalid email or password." });
    }

    const rawToken = generateOpaqueToken(32);
    const tokenHash = hashSessionToken(rawToken, deps.sessionSecret);
    const expiresAt = new Date(Date.now() + deps.sessionTtlHours * 3600 * 1000);

    const session = await deps.authStore.createSession({
      userId: user.id,
      tokenHash,
      mfaVerified: !user.mfaEnabled,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
      expiresAt,
    });

    await deps.audit.record({
      actorUserId: user.id,
      actionType: "USER_LOGIN_SUCCEEDED",
      targetEntity: "SESSION",
      targetId: session.id,
      afterState: { mfaRequired: user.mfaEnabled },
      ipAddress: request.ip,
    });

    const csrfToken = generateOpaqueToken(24);

    reply.setCookie(SESSION_COOKIE_NAME, rawToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: deps.isProd,
      path: "/",
      expires: expiresAt,
    });

    reply.setCookie(CSRF_COOKIE_NAME, csrfToken, {
      httpOnly: false,
      sameSite: "lax",
      secure: deps.isProd,
      path: "/",
      expires: expiresAt,
    });

    return reply.code(200).send({
      token: rawToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        mfaEnabled: user.mfaEnabled,
        mfaVerified: session.mfaVerified,
      },
    });
  });

  app.post("/api/v1/auth/logout", { preHandler: [deps.authenticate] }, async (request, reply) => {
    const auth = request.auth!;
    await deps.authStore.revokeSession(auth.sessionId);
    await deps.audit.record({
      actorUserId: auth.userId,
      actionType: "USER_LOGOUT",
      targetEntity: "SESSION",
      targetId: auth.sessionId,
      ipAddress: request.ip,
    });
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    reply.clearCookie(CSRF_COOKIE_NAME, { path: "/" });
    return reply.code(200).send({ ok: true });
  });

  app.get("/api/v1/auth/me", { preHandler: [deps.authenticate] }, async (request, reply) => {
    return reply.code(200).send({ user: request.auth });
  });

  app.post("/api/v1/auth/2fa/setup", { preHandler: [deps.authenticate] }, async (request, reply) => {
    const auth = request.auth!;
    const existingUser = await deps.authStore.findUserById(auth.userId);
    if (existingUser?.mfaEnabled) {
      return reply.code(409).send({
        error: "2FA is already enabled for this account.",
        code: "MFA_ALREADY_ENABLED",
      });
    }

    const secret = generateTotpSecret();
    const encryptedTotpSecret = encryptSensitiveValue(secret, deps.encryptionKeyHex);

    await deps.authStore.updateUserMfa(auth.userId, {
      encryptedTotpSecret,
      mfaEnabled: false,
    });

    await deps.audit.record({
      actorUserId: auth.userId,
      actionType: "USER_2FA_SETUP_INITIATED",
      targetEntity: "USER",
      targetId: auth.userId,
      ipAddress: request.ip,
    });

    return reply.code(200).send({
      otpauthUri: buildOtpAuthUri(auth.email, secret),
      manualKey: secret,
    });
  });

  app.post(
    "/api/v1/auth/2fa/enable",
    { config: authRateLimit, preHandler: [deps.authenticate] },
    async (request, reply) => {
      const parsed = totpCodeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "A 6-digit TOTP code is required." });
      }

      const auth = request.auth!;
      const user = await deps.authStore.findUserById(auth.userId);
      if (user?.mfaEnabled) {
        return reply.code(409).send({ error: "2FA is already enabled." });
      }
      if (!user?.encryptedTotpSecret) {
        return reply.code(400).send({ error: "2FA setup has not been initiated." });
      }

      const secret = decryptSensitiveValue(user.encryptedTotpSecret, deps.encryptionKeyHex);
      if (!verifyTotpCode(secret, parsed.data.code)) {
        return reply.code(400).send({ error: "Invalid TOTP verification code." });
      }

      const recoveryCodes = generateRecoveryCodes(8);
      const recoveryCodeHashes = recoveryCodes.map((c) => hashRecoveryCode(c, deps.sessionSecret));

      await deps.authStore.updateUserMfa(user.id, {
        encryptedTotpSecret: user.encryptedTotpSecret,
        mfaEnabled: true,
        recoveryCodeHashes,
      });
      await deps.authStore.markSessionMfaVerified(auth.sessionId);

      await deps.audit.record({
        actorUserId: user.id,
        actionType: "USER_2FA_ENABLED",
        targetEntity: "USER",
        targetId: user.id,
        ipAddress: request.ip,
      });

      return reply.code(200).send({
        mfaEnabled: true,
        mfaVerified: true,
        recoveryCodes,
      });
    }
  );

  app.post(
    "/api/v1/auth/2fa/verify",
    { config: authRateLimit, preHandler: [deps.authenticate] },
    async (request, reply) => {
      const parsed = totpCodeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "A 6-digit TOTP code is required." });
      }

      const auth = request.auth!;
      const user = await deps.authStore.findUserById(auth.userId);
      if (!user?.mfaEnabled || !user.encryptedTotpSecret) {
        return reply.code(400).send({ error: "2FA is not enabled for this user." });
      }

      const secret = decryptSensitiveValue(user.encryptedTotpSecret, deps.encryptionKeyHex);
      if (!verifyTotpCode(secret, parsed.data.code)) {
        await deps.audit.record({
          actorUserId: user.id,
          actionType: "USER_2FA_VERIFY_FAILED",
          targetEntity: "SESSION",
          targetId: auth.sessionId,
          ipAddress: request.ip,
        });
        return reply.code(401).send({ error: "Invalid 2FA code." });
      }

      await deps.authStore.markSessionMfaVerified(auth.sessionId);
      await deps.audit.record({
        actorUserId: user.id,
        actionType: "USER_2FA_VERIFIED",
        targetEntity: "SESSION",
        targetId: auth.sessionId,
        ipAddress: request.ip,
      });

      return reply.code(200).send({ mfaVerified: true });
    }
  );

  app.post(
    "/api/v1/auth/2fa/recover",
    { config: authRateLimit, preHandler: [deps.authenticate] },
    async (request, reply) => {
      const parsed = recoveryCodeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "A valid recovery code is required." });
      }

      const auth = request.auth!;
      const user = await deps.authStore.findUserById(auth.userId);
      if (!user?.mfaEnabled || !user.encryptedTotpSecret || !user.recoveryCodeHashes?.length) {
        return reply.code(400).send({ error: "No recovery codes available for this account." });
      }

      const result = consumeRecoveryCode(
        parsed.data.recoveryCode,
        user.recoveryCodeHashes,
        deps.sessionSecret
      );
      if (!result.matched) {
        await deps.audit.record({
          actorUserId: user.id,
          actionType: "USER_2FA_RECOVERY_FAILED",
          targetEntity: "SESSION",
          targetId: auth.sessionId,
          ipAddress: request.ip,
        });
        return reply.code(401).send({ error: "Invalid recovery code." });
      }

      await deps.authStore.updateUserMfa(user.id, {
        encryptedTotpSecret: user.encryptedTotpSecret,
        mfaEnabled: true,
        recoveryCodeHashes: result.remainingHashes,
      });
      await deps.authStore.markSessionMfaVerified(auth.sessionId);

      await deps.audit.record({
        actorUserId: user.id,
        actionType: "USER_2FA_RECOVERY_USED",
        targetEntity: "USER",
        targetId: user.id,
        afterState: { remainingRecoveryCodes: result.remainingHashes.length },
        ipAddress: request.ip,
      });

      return reply.code(200).send({
        mfaVerified: true,
        remainingRecoveryCodes: result.remainingHashes.length,
      });
    }
  );
}

