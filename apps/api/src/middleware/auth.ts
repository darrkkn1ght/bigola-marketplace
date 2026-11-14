import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { hasPermission, Permission, UserRole } from "@bigola/shared";
import { hashSessionToken } from "../lib/crypto.js";
import type { AuthStore } from "../lib/repositories.js";

export interface AuthenticatedContext {
  sessionId: string;
  userId: string;
  email: string;
  role: UserRole;
  mfaEnabled: boolean;
  mfaVerified: boolean;
  authTransport: "cookie" | "bearer";
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthenticatedContext;
  }
}

export const SESSION_COOKIE_NAME = "bigola_session";
export const CSRF_COOKIE_NAME = "bigola_csrf";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function createAuthMiddleware(opts: {
  authStore: AuthStore;
  sessionSecret: string;
  ownerRequire2fa: boolean;
  webBaseUrl: string;
}) {
  const allowedOrigin = new URL(opts.webBaseUrl).origin;

  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const cookieToken = request.cookies?.[SESSION_COOKIE_NAME];
    const authHeader = request.headers.authorization;
    const bearerToken =
      authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;
    const rawToken = bearerToken || cookieToken;
    const authTransport = bearerToken ? "bearer" : "cookie";

    if (!rawToken) {
      return reply.code(401).send({ error: "Authentication required." });
    }

    // Enforce Origin + double-submit CSRF token on cookie-authenticated state-changing requests
    if (authTransport === "cookie" && MUTATING_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      if (origin && origin !== allowedOrigin) {
        return reply.code(403).send({ error: "CSRF validation failed: origin mismatch." });
      }
      const csrfCookie = request.cookies?.[CSRF_COOKIE_NAME];
      const csrfHeader = request.headers["x-csrf-token"];
      if (
        !csrfCookie ||
        typeof csrfHeader !== "string" ||
        csrfCookie.length !== csrfHeader.length ||
        !crypto.timingSafeEqual(Buffer.from(csrfCookie, "utf8"), Buffer.from(csrfHeader, "utf8"))
      ) {
        return reply.code(403).send({ error: "CSRF token missing or invalid." });
      }
    }

    const tokenHash = hashSessionToken(rawToken, opts.sessionSecret);
    const session = await opts.authStore.findSessionByTokenHash(tokenHash);

    if (!session || session.revokedAt || session.expiresAt <= new Date() || !session.user.isActive) {
      return reply.code(401).send({ error: "Invalid or expired session." });
    }

    request.auth = {
      sessionId: session.id,
      userId: session.user.id,
      email: session.user.email,
      role: session.user.role,
      mfaEnabled: session.user.mfaEnabled,
      mfaVerified: session.mfaVerified,
      authTransport,
    };
  }

  function requirePermission(permission: Permission, options?: { enforceOwner2fa?: boolean }) {
    return async function permissionGuard(request: FastifyRequest, reply: FastifyReply) {
      if (!request.auth) {
        return reply.code(401).send({ error: "Authentication required." });
      }
      if (!hasPermission(request.auth.role, permission)) {
        return reply.code(403).send({ error: "Forbidden: insufficient role permissions." });
      }
      if (
        (options?.enforceOwner2fa ?? true) &&
        opts.ownerRequire2fa &&
        request.auth.role === UserRole.OWNER &&
        (!request.auth.mfaEnabled || !request.auth.mfaVerified)
      ) {
        return reply.code(403).send({
          error: "Owner 2FA verification required before accessing privileged endpoints.",
          code: "MFA_REQUIRED",
        });
      }
    };
  }

  return { authenticate, requirePermission };
}

