import crypto from "node:crypto";
import {
  AccountTokenType,
  AttributionConflictStatus,
  AttributionSource,
  ConflictMatchedField,
  CustomerCategory,
  PartnerStatus,
  Prisma,
  PrismaClient,
  UserRole,
} from "@prisma/client";
import {
  maskIdentifier,
  normalizeEmail,
  normalizeLagoslifeUsername,
  normalizePhone,
  normalizeReferralCode,
} from "@bigola/shared";
import { generateOpaqueToken, hashLookupValue, hashPassword, hashSessionToken } from "../lib/crypto.js";

export class AttributionError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

export class AttributionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sessionSecret: string
  ) {}

  async validateReferralCode(rawCode: string) {
    const code = normalizeReferralCode(rawCode);
    const partner = await this.prisma.partner.findUnique({
      where: { referralCode: code },
      select: { id: true, referralCode: true, displayName: true, status: true },
    });
    if (!partner || partner.status !== PartnerStatus.ACTIVE) {
      return null;
    }
    return partner;
  }

  async registerCustomerOnline(input: {
    email: string;
    phone?: string;
    password: string;
    fullName: string;
    lagoslifeUsername?: string;
    cookieReferralCode: string | null;
    submittedReferralCode?: string;
    ipAddress?: string;
  }) {
    const normalizedEmail = normalizeEmail(input.email);
    const normalizedPhone = input.phone ? normalizePhone(input.phone) : null;
    const normalizedLl = input.lagoslifeUsername
      ? normalizeLagoslifeUsername(input.lagoslifeUsername)
      : null;

    const cookieCode = input.cookieReferralCode
      ? normalizeReferralCode(input.cookieReferralCode)
      : null;
    const bodyCode = input.submittedReferralCode
      ? normalizeReferralCode(input.submittedReferralCode)
      : null;

    // Amendment 2: Reject mismatch between referral cookie and registration payload; never silently choose one.
    if (cookieCode && bodyCode && cookieCode !== bodyCode) {
      throw new AttributionError(
        409,
        "REFERRAL_CONFLICT",
        "Submitted referral code conflicts with your captured referral link. Explicit resolution is required.",
        { cookieReferralCode: cookieCode, submittedReferralCode: bodyCode }
      );
    }

    const effectiveCode = cookieCode ?? bodyCode;
    const attributionSource = cookieCode
      ? AttributionSource.REF_LINK
      : bodyCode
        ? AttributionSource.REF_CODE
        : null;

    let partner: { id: string; referralCode: string; status: PartnerStatus } | null = null;
    if (effectiveCode) {
      partner = await this.prisma.partner.findUnique({
        where: { referralCode: effectiveCode },
        select: { id: true, referralCode: true, status: true },
      });
      if (!partner || partner.status !== PartnerStatus.ACTIVE) {
        throw new AttributionError(400, "INVALID_REFERRAL_CODE", "Referral code is invalid or inactive.");
      }
    }

    const passwordHash = await hashPassword(input.password);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existingUser = await tx.user.findUnique({ where: { email: normalizedEmail } });
        if (existingUser) {
          throw new AttributionError(409, "EMAIL_EXISTS", "An account with this email already exists.");
        }

        const existingCustomer = await tx.customer.findFirst({
          where: {
            OR: [
              { email: normalizedEmail },
              ...(normalizedPhone ? [{ phoneNormalized: normalizedPhone }] : []),
              ...(normalizedLl ? [{ lagoslifeUsernameNormalized: normalizedLl }] : []),
            ],
          },
        });
        if (existingCustomer) {
          throw new AttributionError(
            409,
            "CUSTOMER_ALREADY_EXISTS",
            "A customer with this email, phone, or LagosLife username is already registered."
          );
        }

        const user = await tx.user.create({
          data: {
            email: normalizedEmail,
            phone: normalizedPhone,
            passwordHash,
            role: UserRole.CUSTOMER,
          },
        });

        const category = partner
          ? CustomerCategory.CATEGORY_A_PARTNER
          : CustomerCategory.CATEGORY_B_BIGOLA;

        const customer = await tx.customer.create({
          data: {
            userId: user.id,
            fullName: input.fullName.trim(),
            email: normalizedEmail,
            phone: normalizedPhone,
            phoneNormalized: normalizedPhone,
            lagoslifeUsername: input.lagoslifeUsername?.trim() ?? null,
            lagoslifeUsernameNormalized: normalizedLl,
            category,
            attributedPartnerId: partner ? partner.id : null,
            attributedAt: partner ? new Date() : null,
            attributionSource,
          },
        });

        await tx.auditLog.create({
          data: {
            actorUserId: user.id,
            actionType: "USER_REGISTERED",
            targetEntity: "USER",
            targetId: user.id,
            afterState: {
              email: user.email,
              role: user.role,
              customerId: customer.id,
              category: customer.category,
              attributedPartnerId: customer.attributedPartnerId,
              attributionSource: customer.attributionSource,
            },
            ipAddress: input.ipAddress ?? null,
          },
        });

        return {
          user: { id: user.id, email: user.email, role: user.role },
          customer: {
            id: customer.id,
            category: customer.category,
            attributedPartnerId: customer.attributedPartnerId,
            attributionSource: customer.attributionSource,
          },
        };
      });
    } catch (err) {
      if (err instanceof AttributionError) throw err;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new AttributionError(409, "DUPLICATE_IDENTIFIER", "Email, phone, or username already exists.");
      }
      throw err;
    }
  }

  async registerOfflineCustomerByPartner(input: {
    partnerUserId: string;
    fullName: string;
    email?: string;
    phone?: string;
    lagoslifeUsername?: string;
    ipAddress?: string;
  }) {
    if (!input.email && !input.phone && !input.lagoslifeUsername) {
      throw new AttributionError(
        400,
        "IDENTIFIER_REQUIRED",
        "Provide at least one identifier (email, phone, or LagosLife username)."
      );
    }

    const partner = await this.prisma.partner.findUnique({
      where: { userId: input.partnerUserId },
    });
    if (!partner || partner.status !== PartnerStatus.ACTIVE) {
      throw new AttributionError(403, "PARTNER_INACTIVE", "Active partner profile required.");
    }

    const normalizedEmail = input.email ? normalizeEmail(input.email) : null;
    const normalizedPhone = input.phone ? normalizePhone(input.phone) : null;
    const normalizedLl = input.lagoslifeUsername
      ? normalizeLagoslifeUsername(input.lagoslifeUsername)
      : null;

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.customer.findFirst({
        where: {
          OR: [
            ...(normalizedEmail ? [{ email: normalizedEmail }] : []),
            ...(normalizedPhone ? [{ phoneNormalized: normalizedPhone }] : []),
            ...(normalizedLl ? [{ lagoslifeUsernameNormalized: normalizedLl }] : []),
          ],
        },
      });

      if (existing) {
        let matchedField: ConflictMatchedField = ConflictMatchedField.LAGOSLIFE_USERNAME;
        let matchedRaw = normalizedLl ?? "";
        if (normalizedEmail && existing.email === normalizedEmail) {
          matchedField = ConflictMatchedField.EMAIL;
          matchedRaw = normalizedEmail;
        } else if (normalizedPhone && existing.phoneNormalized === normalizedPhone) {
          matchedField = ConflictMatchedField.PHONE;
          matchedRaw = normalizedPhone;
        }

        const conflict = await tx.attributionConflict.create({
          data: {
            existingCustomerId: existing.id,
            existingPartnerId: existing.attributedPartnerId,
            requestedPartnerId: partner.id,
            requestedByUserId: input.partnerUserId,
            matchedField,
            matchedValueHash: hashLookupValue(matchedRaw, this.sessionSecret),
            matchedValueMasked: maskIdentifier(matchedRaw, matchedField),
            status: AttributionConflictStatus.PENDING,
          },
        });

        await tx.auditLog.create({
          data: {
            actorUserId: input.partnerUserId,
            actionType: "ATTRIBUTION_CONFLICT_RECORDED",
            targetEntity: "ATTRIBUTION_CONFLICT",
            targetId: conflict.id,
            afterState: {
              existingCustomerId: existing.id,
              existingPartnerId: existing.attributedPartnerId,
              requestedPartnerId: partner.id,
              matchedField,
            },
            ipAddress: input.ipAddress ?? null,
          },
        });

        return {
          status: "CONFLICT" as const,
          conflictId: conflict.id,
          matchedField,
          matchedValueMasked: conflict.matchedValueMasked,
        };
      }

      const customer = await tx.customer.create({
        data: {
          fullName: input.fullName.trim(),
          email: normalizedEmail,
          phone: normalizedPhone,
          phoneNormalized: normalizedPhone,
          lagoslifeUsername: input.lagoslifeUsername?.trim() ?? null,
          lagoslifeUsernameNormalized: normalizedLl,
          category: CustomerCategory.CATEGORY_A_PARTNER,
          attributedPartnerId: partner.id,
          attributedAt: new Date(),
          attributionSource: AttributionSource.PARTNER_OFFLINE,
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: input.partnerUserId,
          actionType: "OFFLINE_CUSTOMER_ATTRIBUTED",
          targetEntity: "CUSTOMER",
          targetId: customer.id,
          afterState: {
            partnerId: partner.id,
            category: customer.category,
            attributionSource: customer.attributionSource,
          },
          ipAddress: input.ipAddress ?? null,
        },
      });

      return {
        status: "CREATED" as const,
        customer: {
          id: customer.id,
          fullName: customer.fullName,
          category: customer.category,
          attributedPartnerId: customer.attributedPartnerId,
          attributionSource: customer.attributionSource,
        },
      };
    });
  }

  async createPartnerAccount(input: {
    ownerUserId: string;
    email: string;
    phone?: string;
    password?: string;
    displayName: string;
    requestedReferralCode?: string;
    ipAddress?: string;
  }) {
    const normalizedEmail = normalizeEmail(input.email);
    const normalizedPhone = input.phone ? normalizePhone(input.phone) : null;
    const isInvite = !input.password;
    const passwordHash = await hashPassword(
      input.password ?? crypto.randomBytes(32).toString("hex")
    );
    const rawInviteToken = isInvite ? generateOpaqueToken(24) : null;
    const inviteTokenHash = rawInviteToken
      ? crypto.createHash("sha256").update(rawInviteToken).digest("hex")
      : null;
    const inviteExpiresAt = isInvite ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null;

    for (let attempt = 0; attempt < 5; attempt++) {
      const code =
        attempt === 0 && input.requestedReferralCode
          ? normalizeReferralCode(input.requestedReferralCode)
          : `BGO-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

      try {
        return await this.prisma.$transaction(async (tx) => {
          const existingUser = await tx.user.findUnique({ where: { email: normalizedEmail } });
          if (existingUser) {
            throw new AttributionError(409, "EMAIL_EXISTS", "A user with this email already exists.");
          }

          const user = await tx.user.create({
            data: {
              email: normalizedEmail,
              phone: normalizedPhone,
              passwordHash,
              role: UserRole.PARTNER,
              mustChangePassword: isInvite,
            },
          });

          const partner = await tx.partner.create({
            data: {
              userId: user.id,
              referralCode: code,
              displayName: input.displayName.trim(),
              status: PartnerStatus.ACTIVE,
            },
          });

          if (inviteTokenHash && inviteExpiresAt) {
            await tx.accountActionToken.create({
              data: {
                userId: user.id,
                tokenHash: inviteTokenHash,
                type: AccountTokenType.PARTNER_INVITE,
                issuedById: input.ownerUserId,
                expiresAt: inviteExpiresAt,
              },
            });
          }

          await tx.auditLog.create({
            data: {
              actorUserId: input.ownerUserId,
              actionType: "PARTNER_CREATED",
              targetEntity: "PARTNER",
              targetId: partner.id,
              afterState: {
                userId: user.id,
                email: user.email,
                referralCode: partner.referralCode,
                displayName: partner.displayName,
                invitedWithoutPassword: isInvite,
              },
              ipAddress: input.ipAddress ?? null,
            },
          });

          return {
            user: { id: user.id, email: user.email, role: user.role },
            partner,
            ...(rawInviteToken && inviteExpiresAt
              ? { inviteToken: rawInviteToken, inviteExpiresAt: inviteExpiresAt.toISOString() }
              : {}),
          };
        });
      } catch (err) {
        if (err instanceof AttributionError) throw err;
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          const target = (err.meta?.target as string[] | undefined) ?? [];
          if (target.includes("referral_code") && !input.requestedReferralCode) {
            continue; // Collision retry on generated referral code
          }
          throw new AttributionError(409, "CONFLICT", "Partner email, phone, or referral code already exists.");
        }
        throw err;
      }
    }

    throw new AttributionError(500, "REFERRAL_GENERATION_FAILED", "Failed to generate unique referral code.");
  }

  async resolveAttributionConflict(input: {
    conflictId: string;
    ownerUserId: string;
    decision: "KEEP_EXISTING" | "REASSIGN_TO_REQUESTED" | "DISMISS";
    reason: string;
    ipAddress?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const conflict = await tx.attributionConflict.findUnique({
        where: { id: input.conflictId },
        include: { existingCustomer: true },
      });
      if (!conflict) {
        throw new AttributionError(404, "CONFLICT_NOT_FOUND", "Attribution conflict not found.");
      }
      if (conflict.status !== AttributionConflictStatus.PENDING) {
        throw new AttributionError(409, "CONFLICT_ALREADY_RESOLVED", "Conflict has already been resolved.");
      }

      const beforeState = {
        customerId: conflict.existingCustomer.id,
        category: conflict.existingCustomer.category,
        attributedPartnerId: conflict.existingCustomer.attributedPartnerId,
      };

      let newStatus: AttributionConflictStatus = AttributionConflictStatus.DISMISSED;
      if (input.decision === "KEEP_EXISTING") {
        newStatus = AttributionConflictStatus.RESOLVED_KEPT_EXISTING;
      } else if (input.decision === "REASSIGN_TO_REQUESTED") {
        newStatus = AttributionConflictStatus.RESOLVED_REASSIGNED;
        await tx.customer.update({
          where: { id: conflict.existingCustomerId },
          data: {
            category: CustomerCategory.CATEGORY_A_PARTNER,
            attributedPartnerId: conflict.requestedPartnerId,
            attributedAt: new Date(),
            attributionSource: AttributionSource.OWNER_OFFLINE,
          },
        });
      }

      const updatedConflict = await tx.attributionConflict.update({
        where: { id: conflict.id },
        data: {
          status: newStatus,
          resolutionReason: input.reason,
          resolvedById: input.ownerUserId,
          resolvedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: input.ownerUserId,
          actionType: "ATTRIBUTION_CONFLICT_RESOLVED",
          targetEntity: "ATTRIBUTION_CONFLICT",
          targetId: conflict.id,
          beforeState,
          afterState: {
            decision: input.decision,
            status: newStatus,
            newPartnerId:
              input.decision === "REASSIGN_TO_REQUESTED"
                ? conflict.requestedPartnerId
                : beforeState.attributedPartnerId,
          },
          reason: input.reason,
          ipAddress: input.ipAddress ?? null,
        },
      });

      return updatedConflict;
    });
  }

  async overrideCustomerAttribution(input: {
    customerId: string;
    ownerUserId: string;
    targetPartnerId: string | null;
    reason: string;
    ipAddress?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.customer.findUnique({ where: { id: input.customerId } });
      if (!existing) {
        throw new AttributionError(404, "CUSTOMER_NOT_FOUND", "Customer not found.");
      }

      if (input.targetPartnerId) {
        const partner = await tx.partner.findUnique({ where: { id: input.targetPartnerId } });
        if (!partner) {
          throw new AttributionError(404, "PARTNER_NOT_FOUND", "Target partner not found.");
        }
      }

      const beforeState = {
        category: existing.category,
        attributedPartnerId: existing.attributedPartnerId,
        attributionSource: existing.attributionSource,
      };

      const updated = await tx.customer.update({
        where: { id: existing.id },
        data: {
          category: input.targetPartnerId
            ? CustomerCategory.CATEGORY_A_PARTNER
            : CustomerCategory.CATEGORY_B_BIGOLA,
          attributedPartnerId: input.targetPartnerId,
          attributedAt: input.targetPartnerId ? new Date() : null,
          attributionSource: input.targetPartnerId ? AttributionSource.OWNER_OFFLINE : null,
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: input.ownerUserId,
          actionType: "CUSTOMER_ATTRIBUTION_OVERRIDDEN",
          targetEntity: "CUSTOMER",
          targetId: updated.id,
          beforeState,
          afterState: {
            category: updated.category,
            attributedPartnerId: updated.attributedPartnerId,
            attributionSource: updated.attributionSource,
          },
          reason: input.reason,
          ipAddress: input.ipAddress ?? null,
        },
      });

      return updated;
    });
  }
}

