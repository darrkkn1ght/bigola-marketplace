import {
  CommissionLedgerEntryType,
  CommissionRuleStatus,
  CommissionSettlementStatus,
  CustomerCategory,
  OrderStatus,
  Prisma,
  PrismaClient,
  ProofVerificationStatus,
} from "@prisma/client";
import { calculateCommissionSplit } from "@bigola/shared";

export class CommissionError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export class CommissionService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Generates an immutable CommissionRecord and append-only ACCRUAL ledger entry
   * ONLY for an order whose payment has been verified (`PAYMENT_VERIFIED`) with an `APPROVED` proof.
   * Never exposed as a public/user-callable endpoint.
   */
  async recordCommissionForVerifiedOrder(orderId: string, verifiedByUserId: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: orderId },
          include: {
            paymentProofs: {
              where: { verificationStatus: ProofVerificationStatus.APPROVED },
              select: { id: true },
              take: 1,
            },
            commissionRecord: { select: { id: true } },
          },
        });

        if (!order) {
          throw new CommissionError(404, "ORDER_NOT_FOUND", "Order not found.");
        }

        if (order.commissionRecord) {
          throw new CommissionError(
            409,
            "DUPLICATE_COMMISSION",
            "Commission record already exists for this order."
          );
        }

        const hasApprovedProof = order.paymentProofs.length > 0;
        if (order.status !== OrderStatus.PAYMENT_VERIFIED || !hasApprovedProof) {
          throw new CommissionError(
            400,
            "ORDER_NOT_VERIFIED",
            "Commissions can only be generated from a verified payment with an approved proof."
          );
        }

        if (order.customerCategory === CustomerCategory.CATEGORY_A_PARTNER) {
          const rule = await tx.commissionRule.findFirst({
            where: {
              category: CustomerCategory.CATEGORY_A_PARTNER,
              status: CommissionRuleStatus.ACTIVE,
            },
            orderBy: { effectiveFrom: "desc" },
          });
          if (!rule) {
            throw new CommissionError(500, "MISSING_CATEGORY_A_RULE", "Active Category A rule not found.");
          }

          const split = calculateCommissionSplit(order.fiatAmountKobo, {
            category: "CATEGORY_A_PARTNER",
            partnerShareBps: 5000,
            ownerShareBps: 5000,
          });

          const record = await tx.commissionRecord.create({
            data: {
              orderId: order.id,
              partnerId: order.partnerId,
              category: CustomerCategory.CATEGORY_A_PARTNER,
              ruleId: rule.id,
              grossFiatKobo: order.fiatAmountKobo,
              partnerEntitlementKobo: split.partnerEntitlementKobo,
              ownerEntitlementKobo: split.ownerEntitlementKobo,
              settlementStatus: CommissionSettlementStatus.ACCRUED,
            },
          });

          await tx.commissionLedgerEntry.create({
            data: {
              commissionRecordId: record.id,
              partnerId: order.partnerId,
              entryType: CommissionLedgerEntryType.ACCRUAL,
              partnerDeltaKobo: split.partnerEntitlementKobo!,
              ownerDeltaKobo: split.ownerEntitlementKobo!,
              notes: "50/50 gross verified payment accrual (Category A)",
              createdById: verifiedByUserId,
            },
          });

          return record;
        }

        // Category B: remains PENDING_RULE with zero payable entitlement until Owner configures a rule
        const catBRule = await tx.commissionRule.findFirst({
          where: { category: CustomerCategory.CATEGORY_B_BIGOLA },
          orderBy: { effectiveFrom: "desc" },
        });
        if (!catBRule) {
          throw new CommissionError(500, "MISSING_CATEGORY_B_RULE", "Category B rule placeholder not found.");
        }

        if (catBRule.status === CommissionRuleStatus.PENDING_RULE) {
          return tx.commissionRecord.create({
            data: {
              orderId: order.id,
              partnerId: null,
              category: CustomerCategory.CATEGORY_B_BIGOLA,
              ruleId: catBRule.id,
              grossFiatKobo: order.fiatAmountKobo,
              partnerEntitlementKobo: null,
              ownerEntitlementKobo: null,
              settlementStatus: CommissionSettlementStatus.PENDING_RULE,
            },
          });
        }

        const split = calculateCommissionSplit(order.fiatAmountKobo, {
          category: "CATEGORY_B_BIGOLA",
          status: "CONFIGURED",
          partnerShareBps: catBRule.partnerShareBps!,
          ownerShareBps: catBRule.ownerShareBps!,
        });

        const record = await tx.commissionRecord.create({
          data: {
            orderId: order.id,
            partnerId: order.partnerId,
            category: CustomerCategory.CATEGORY_B_BIGOLA,
            ruleId: catBRule.id,
            grossFiatKobo: order.fiatAmountKobo,
            partnerEntitlementKobo: split.partnerEntitlementKobo,
            ownerEntitlementKobo: split.ownerEntitlementKobo,
            settlementStatus: CommissionSettlementStatus.ACCRUED,
          },
        });

        await tx.commissionLedgerEntry.create({
          data: {
            commissionRecordId: record.id,
            partnerId: order.partnerId,
            entryType: CommissionLedgerEntryType.ACCRUAL,
            partnerDeltaKobo: split.partnerEntitlementKobo!,
            ownerDeltaKobo: split.ownerEntitlementKobo!,
            notes: "Configured Category B accrual",
            createdById: verifiedByUserId,
          },
        });

        return record;
      }, { maxWait: 10000, timeout: 15000 });
    } catch (err) {
      if (err instanceof CommissionError) throw err;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new CommissionError(409, "DUPLICATE_COMMISSION", "Commission record already exists for this order.");
      }
      throw err;
    }
  }

  async approveForPayout(commissionRecordId: string, ownerUserId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const record = await tx.commissionRecord.findUnique({ where: { id: commissionRecordId } });
      if (!record) throw new CommissionError(404, "RECORD_NOT_FOUND", "Commission record not found.");
      if (record.settlementStatus !== CommissionSettlementStatus.ACCRUED) {
        throw new CommissionError(409, "INVALID_TRANSITION", "Only ACCRUED commissions can be approved for payout.");
      }

      const updated = await tx.commissionRecord.update({
        where: { id: record.id },
        data: { settlementStatus: CommissionSettlementStatus.APPROVED_FOR_PAYOUT },
      });

      await tx.commissionLedgerEntry.create({
        data: {
          commissionRecordId: record.id,
          partnerId: record.partnerId,
          entryType: CommissionLedgerEntryType.APPROVAL,
          partnerDeltaKobo: 0n,
          ownerDeltaKobo: 0n,
          notes: reason,
          createdById: ownerUserId,
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: ownerUserId,
          actionType: "COMMISSION_APPROVED_FOR_PAYOUT",
          targetEntity: "COMMISSION_RECORD",
          targetId: record.id,
          beforeState: { settlementStatus: record.settlementStatus },
          afterState: { settlementStatus: updated.settlementStatus },
          reason,
        },
      });

      return updated;
    }, { maxWait: 10000, timeout: 15000 });
  }

  async reverseCommission(commissionRecordId: string, ownerUserId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const record = await tx.commissionRecord.findUnique({ where: { id: commissionRecordId } });
      if (!record) throw new CommissionError(404, "RECORD_NOT_FOUND", "Commission record not found.");
      if (
        record.settlementStatus === CommissionSettlementStatus.REVERSED ||
        record.settlementStatus === CommissionSettlementStatus.PENDING_RULE
      ) {
        throw new CommissionError(409, "INVALID_TRANSITION", "Commission cannot be reversed from its current state.");
      }

      const updated = await tx.commissionRecord.update({
        where: { id: record.id },
        data: { settlementStatus: CommissionSettlementStatus.REVERSED },
      });

      await tx.commissionLedgerEntry.create({
        data: {
          commissionRecordId: record.id,
          partnerId: record.partnerId,
          entryType: CommissionLedgerEntryType.REVERSAL,
          partnerDeltaKobo: -(record.partnerEntitlementKobo ?? 0n),
          ownerDeltaKobo: -(record.ownerEntitlementKobo ?? 0n),
          notes: reason,
          createdById: ownerUserId,
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: ownerUserId,
          actionType: "COMMISSION_REVERSED",
          targetEntity: "COMMISSION_RECORD",
          targetId: record.id,
          beforeState: { settlementStatus: record.settlementStatus },
          afterState: { settlementStatus: updated.settlementStatus },
          reason,
        },
      });

      return updated;
    }, { maxWait: 10000, timeout: 15000 });
  }

  /**
   * Phase 5: Accrues commission inside an existing verification transaction for a specific fundingCycle.
   * Supports re-accrual in a new fundingCycle after a prior cycle was reversed.
   */
  async accrueForVerifiedOrderInTx(
    tx: Prisma.TransactionClient,
    input: {
      orderId: string;
      verifiedByUserId: string;
      grossFiatKobo: bigint;
      fundingCycle: number;
      reference: string;
    }
  ) {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: input.orderId },
      include: { commissionRecord: true },
    });

    if (order.customerCategory === CustomerCategory.CATEGORY_A_PARTNER) {
      const rule = await tx.commissionRule.findFirst({
        where: {
          category: CustomerCategory.CATEGORY_A_PARTNER,
          status: CommissionRuleStatus.ACTIVE,
        },
        orderBy: { effectiveFrom: "desc" },
      });
      if (!rule) {
        throw new CommissionError(500, "MISSING_CATEGORY_A_RULE", "Active Category A rule not found.");
      }

      const split = calculateCommissionSplit(input.grossFiatKobo, {
        category: "CATEGORY_A_PARTNER",
        partnerShareBps: 5000,
        ownerShareBps: 5000,
      });

      const record = order.commissionRecord
        ? await tx.commissionRecord.update({
            where: { id: order.commissionRecord.id },
            data: {
              ruleId: rule.id,
              grossFiatKobo: input.grossFiatKobo,
              partnerEntitlementKobo: split.partnerEntitlementKobo,
              ownerEntitlementKobo: split.ownerEntitlementKobo,
              settlementStatus: CommissionSettlementStatus.ACCRUED,
            },
          })
        : await tx.commissionRecord.create({
            data: {
              orderId: order.id,
              partnerId: order.partnerId,
              category: CustomerCategory.CATEGORY_A_PARTNER,
              ruleId: rule.id,
              grossFiatKobo: input.grossFiatKobo,
              partnerEntitlementKobo: split.partnerEntitlementKobo,
              ownerEntitlementKobo: split.ownerEntitlementKobo,
              settlementStatus: CommissionSettlementStatus.ACCRUED,
            },
          });

      await tx.commissionLedgerEntry.create({
        data: {
          commissionRecordId: record.id,
          partnerId: order.partnerId,
          fundingCycle: input.fundingCycle,
          entryType: CommissionLedgerEntryType.ACCRUAL,
          partnerDeltaKobo: split.partnerEntitlementKobo!,
          ownerDeltaKobo: split.ownerEntitlementKobo!,
          reference: input.reference,
          notes: `50/50 gross verified payment accrual (Category A, cycle ${input.fundingCycle})`,
          createdById: input.verifiedByUserId,
        },
      });

      return record;
    }

    const catBRule = await tx.commissionRule.findFirst({
      where: { category: CustomerCategory.CATEGORY_B_BIGOLA },
      orderBy: { effectiveFrom: "desc" },
    });
    if (!catBRule) {
      throw new CommissionError(500, "MISSING_CATEGORY_B_RULE", "Category B rule placeholder not found.");
    }

    if (catBRule.status === CommissionRuleStatus.PENDING_RULE) {
      return order.commissionRecord
        ? tx.commissionRecord.update({
            where: { id: order.commissionRecord.id },
            data: {
              grossFiatKobo: input.grossFiatKobo,
              partnerEntitlementKobo: null,
              ownerEntitlementKobo: null,
              settlementStatus: CommissionSettlementStatus.PENDING_RULE,
            },
          })
        : tx.commissionRecord.create({
            data: {
              orderId: order.id,
              partnerId: null,
              category: CustomerCategory.CATEGORY_B_BIGOLA,
              ruleId: catBRule.id,
              grossFiatKobo: input.grossFiatKobo,
              partnerEntitlementKobo: null,
              ownerEntitlementKobo: null,
              settlementStatus: CommissionSettlementStatus.PENDING_RULE,
            },
          });
    }

    const split = calculateCommissionSplit(input.grossFiatKobo, {
      category: "CATEGORY_B_BIGOLA",
      status: "CONFIGURED",
      partnerShareBps: catBRule.partnerShareBps!,
      ownerShareBps: catBRule.ownerShareBps!,
    });

    const record = order.commissionRecord
      ? await tx.commissionRecord.update({
          where: { id: order.commissionRecord.id },
          data: {
            ruleId: catBRule.id,
            grossFiatKobo: input.grossFiatKobo,
            partnerEntitlementKobo: split.partnerEntitlementKobo,
            ownerEntitlementKobo: split.ownerEntitlementKobo,
            settlementStatus: CommissionSettlementStatus.ACCRUED,
          },
        })
      : await tx.commissionRecord.create({
          data: {
            orderId: order.id,
            partnerId: order.partnerId,
            category: CustomerCategory.CATEGORY_B_BIGOLA,
            ruleId: catBRule.id,
            grossFiatKobo: input.grossFiatKobo,
            partnerEntitlementKobo: split.partnerEntitlementKobo,
            ownerEntitlementKobo: split.ownerEntitlementKobo,
            settlementStatus: CommissionSettlementStatus.ACCRUED,
          },
        });

    await tx.commissionLedgerEntry.create({
      data: {
        commissionRecordId: record.id,
        partnerId: order.partnerId,
        fundingCycle: input.fundingCycle,
        entryType: CommissionLedgerEntryType.ACCRUAL,
        partnerDeltaKobo: split.partnerEntitlementKobo!,
        ownerDeltaKobo: split.ownerEntitlementKobo!,
        reference: input.reference,
        notes: `Configured Category B accrual (cycle ${input.fundingCycle})`,
        createdById: input.verifiedByUserId,
      },
    });

    return record;
  }

  /**
   * Phase 5: Reverses an order's active commission entitlement inside an existing transaction
   * when a payment reversal drops cumulative verified credits below the order amount.
   */
  async reverseForOrderInTx(
    tx: Prisma.TransactionClient,
    input: {
      orderId: string;
      actorUserId: string;
      fundingCycle: number;
      reference: string;
      reason: string;
    }
  ) {
    const record = await tx.commissionRecord.findUnique({
      where: { orderId: input.orderId },
    });
    if (!record || record.settlementStatus === CommissionSettlementStatus.REVERSED) {
      return null;
    }

    const prevStatus = record.settlementStatus;
    const updated = await tx.commissionRecord.update({
      where: { id: record.id },
      data: { settlementStatus: CommissionSettlementStatus.REVERSED },
    });

    if (prevStatus !== CommissionSettlementStatus.PENDING_RULE) {
      await tx.commissionLedgerEntry.create({
        data: {
          commissionRecordId: record.id,
          partnerId: record.partnerId,
          fundingCycle: input.fundingCycle,
          entryType: CommissionLedgerEntryType.REVERSAL,
          partnerDeltaKobo: -(record.partnerEntitlementKobo ?? 0n),
          ownerDeltaKobo: -(record.ownerEntitlementKobo ?? 0n),
          reference: input.reference,
          notes: `${input.reason} (cycle ${input.fundingCycle})`,
          createdById: input.actorUserId,
        },
      });
    }

    return updated;
  }
}

