import type { FastifyInstance } from "fastify";
import { signReferralCookieValue, verifyReferralCookieValue } from "../lib/crypto.js";
import type { AttributionService } from "../services/attribution.js";

export const REFERRAL_COOKIE_NAME = "bigola_ref";

export function registerReferralRoutes(
  app: FastifyInstance,
  deps: {
    attributionService?: AttributionService;
    sessionSecret: string;
    isProd: boolean;
  }
) {
  app.get("/api/v1/referrals/validate/:code", async (request, reply) => {
    if (!deps.attributionService) {
      return reply.code(503).send({ error: "Attribution service unavailable." });
    }

    const { code } = request.params as { code: string };
    const existingRaw = request.cookies?.[REFERRAL_COOKIE_NAME];
    const existingCode = existingRaw
      ? verifyReferralCookieValue(existingRaw, deps.sessionSecret)
      : null;

    // Amendment 1: First-valid-referral-wins before registration.
    if (existingCode) {
      const existingPartner = await deps.attributionService.validateReferralCode(existingCode);
      if (existingPartner) {
        return reply.code(200).send({
          valid: true,
          firstReferralPreserved: true,
          referralCode: existingPartner.referralCode,
          partnerDisplayName: existingPartner.displayName,
        });
      }
    }

    const partner = await deps.attributionService.validateReferralCode(code);
    if (!partner) {
      return reply.code(404).send({ valid: false, error: "Referral code is invalid or inactive." });
    }

    const signed = signReferralCookieValue(partner.referralCode, deps.sessionSecret);
    reply.setCookie(REFERRAL_COOKIE_NAME, signed, {
      httpOnly: true,
      sameSite: deps.isProd ? "none" : "lax",
      secure: deps.isProd,
      path: "/",
      maxAge: 30 * 24 * 3600,
    });

    return reply.code(200).send({
      valid: true,
      firstReferralPreserved: false,
      referralCode: partner.referralCode,
      partnerDisplayName: partner.displayName,
    });
  });
}

