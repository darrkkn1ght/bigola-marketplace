import crypto from "node:crypto";
import {
  BankAccountChangeRequestStatus,
  BankStatementFormat,
  BankStatementLineStatus,
  CommissionLedgerEntryType,
  GameAccountHealth,
  InventoryEntryType,
  InventoryReservationStatus,
  NotificationType,
  OrderStatus,
  PartnerStatus,
  PaymentExceptionType,
  Prisma,
  PrismaClient,
  ProofVerificationStatus,
  UserRole,
  VerificationDecisionType,
} from "@prisma/client";
import {
  DEFAULT_ORDER_EXPIRY_MINUTES,
  normalizeBankReference,
} from "@bigola/shared";
import { CommissionService } from "./commission.js";
import { NotificationService } from "./notification.js";

export class VerificationError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "VerificationError";
  }
}

const MAX_STATEMENT_LINES = 5000;
const MAX_STATEMENT_BYTES = 2_000_000;

function sanitizeCsvCell(value: string): string {
  const trimmed = value.trim();
  if (/^[=+\-@]/.test(trimmed)) {
    return `'${trimmed}`;
  }
  return trimmed;
}

export interface StatementLineInput {
  transactionReference: string;
  amountKobo: string;
  creditedAt: string;
  senderName?: string;
  narration?: string;
}

export class VerificationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly commissionService: CommissionService,
    private readonly notificationService: NotificationService
  ) {}

  async assertAuthorizedVerifier(userId: string, role: UserRole) {
    if (role === UserRole.OWNER) {
      return { userId, role, partnerId: null };
    }
    if (role === UserRole.PARTNER) {
      const partner = await this.prisma.partner.findUnique({
        where: { userId },
      });
      if (!partner || partner.status !== PartnerStatus.ACTIVE || !partner.canVerifyPayments) {
        throw new VerificationError(
          403,
          "VERIFIER_NOT_AUTHORIZED",
          "Partner is not authorized for payment verification."
        );
      }
      return { userId, role, partnerId: partner.id };
    }
    throw new VerificationError(403, "VERIFIER_NOT_AUTHORIZED", "Forbidden: verifier access required.");
  }

  private async getAuthorizedVerifierUserIds(tx: Prisma.TransactionClient): Promise<string[]> {
    const [owners, verifierPartners] = await Promise.all([
      tx.user.findMany({
        where: { role: UserRole.OWNER, isActive: true },
        select: { id: true },
      }),
      tx.partner.findMany({
        where: { status: PartnerStatus.ACTIVE, canVerifyPayments: true },
        select: { userId: true },
      }),
    ]);
    return [...owners.map((o) => o.id), ...verifierPartners.map((p) => p.userId)];
  }

  private async getUnpaidExpiryMinutes(tx: Prisma.TransactionClient): Promise<number | null> {
    const setting = await tx.platformSetting.findUnique({
      where: { key: "order_expiry_policy" },
    });
    const val = (setting?.value ?? {}) as { status?: string; unpaidExpiryMinutes?: unknown };
    if (val.status === "CONFIGURED") {
      if (val.unpaidExpiryMinutes === null) return null;
      const parsed = Number(val.unpaidExpiryMinutes);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_ORDER_EXPIRY_MINUTES;
    }
    return DEFAULT_ORDER_EXPIRY_MINUTES;
  }

  // --- Partner-Owned OPay Account Dual-Control ---

  async listBankAccounts() {
    const [accounts, requests] = await Promise.all([
      this.prisma.receivingBankAccount.findMany({
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
        include: {
          ownerPartner: { select: { id: true, displayName: true, referralCode: true } },
        },
      }),
      this.prisma.receivingBankAccountChangeRequest.findMany({
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
          ownerPartner: { select: { id: true, displayName: true, referralCode: true } },
        },
      }),
    ]);
    return { accounts, changeRequests: requests };
  }

  async proposeBankAccountChange(input: {
    actorUserId: string;
    actorRole: UserRole;
    ownerPartnerId: string;
    actionType: "CREATE" | "UPDATE" | "DEACTIVATE";
    receivingBankAccountId?: string;
    proposedData: {
      bankName?: string;
      bankCode?: string;
      accountNumber?: string;
      accountName?: string;
      isDefault?: boolean;
      isActive?: boolean;
    };
    reason: string;
    ipAddress?: string;
  }) {
    if (input.actionType !== "CREATE") {
      if (!input.receivingBankAccountId) {
        throw new VerificationError(400, "MISSING_BANK_ACCOUNT_ID", "receivingBankAccountId is required.");
      }
      const existing = await this.prisma.receivingBankAccount.findUnique({
        where: { id: input.receivingBankAccountId },
      });
      if (!existing) {
        throw new VerificationError(404, "BANK_ACCOUNT_NOT_FOUND", "Receiving bank account not found.");
      }
      if (existing.ownerPartnerId !== input.ownerPartnerId) {
        throw new VerificationError(403, "PARTNER_OWNERSHIP_MISMATCH", "Bank account belongs to another partner.");
      }
    }

    const partner = await this.prisma.partner.findUnique({
      where: { id: input.ownerPartnerId },
    });
    if (!partner) {
      throw new VerificationError(404, "PARTNER_NOT_FOUND", "Owner partner not found.");
    }

    return this.prisma.$transaction(async (tx) => {
      const req = await tx.receivingBankAccountChangeRequest.create({
        data: {
          receivingBankAccountId: input.receivingBankAccountId ?? null,
          ownerPartnerId: input.ownerPartnerId,
          requestedByUserId: input.actorUserId,
          actionType: input.actionType,
          proposedData: input.proposedData as Prisma.InputJsonValue,
          status: BankAccountChangeRequestStatus.PENDING_PARTNER_CONFIRMATION,
          requestReason: input.reason,
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          actionType: "RECEIVING_BANK_ACCOUNT_CHANGE_PROPOSED",
          targetEntity: "receiving_bank_account_change_requests",
          targetId: req.id,
          afterState: {
            actionType: input.actionType,
            ownerPartnerId: input.ownerPartnerId,
            receivingBankAccountId: input.receivingBankAccountId ?? null,
            proposedData: input.proposedData,
          },
          reason: input.reason,
          ipAddress: input.ipAddress,
        },
      });

      return req;
    }, { maxWait: 15000, timeout: 30000 });
  }

  async confirmBankAccountChange(input: {
    requestId: string;
    partnerUserId: string;
    approve: boolean;
    reason: string;
    ipAddress?: string;
  }) {
    const partner = await this.prisma.partner.findUnique({
      where: { userId: input.partnerUserId },
    });
    if (!partner || partner.status !== PartnerStatus.ACTIVE) {
      throw new VerificationError(403, "PARTNER_REQUIRED", "Active partner account required to confirm.");
    }

    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string; status: BankAccountChangeRequestStatus; owner_partner_id: string }>>`
        SELECT id, status, owner_partner_id
        FROM receiving_bank_account_change_requests
        WHERE id = ${input.requestId}::uuid
        FOR UPDATE
      `;
      const reqRow = locked[0];
      if (!reqRow) {
        throw new VerificationError(404, "REQUEST_NOT_FOUND", "Change request not found.");
      }
      if (reqRow.owner_partner_id !== partner.id) {
        throw new VerificationError(
          403,
          "FORBIDDEN",
          "Only the account-holding Partner can confirm changes to this receiving bank account."
        );
      }
      if (reqRow.status !== BankAccountChangeRequestStatus.PENDING_PARTNER_CONFIRMATION) {
        throw new VerificationError(409, "REQUEST_ALREADY_RESOLVED", "Change request was already resolved.");
      }

      const fullReq = await tx.receivingBankAccountChangeRequest.findUniqueOrThrow({
        where: { id: reqRow.id },
      });

      const now = new Date();
      if (!input.approve) {
        const rejected = await tx.receivingBankAccountChangeRequest.update({
          where: { id: fullReq.id },
          data: {
            status: BankAccountChangeRequestStatus.REJECTED,
            confirmedByUserId: input.partnerUserId,
            confirmationReason: input.reason,
            confirmedAt: now,
          },
        });
        await tx.auditLog.create({
          data: {
            actorUserId: input.partnerUserId,
            actionType: "RECEIVING_BANK_ACCOUNT_CHANGE_REJECTED",
            targetEntity: "receiving_bank_account_change_requests",
            targetId: fullReq.id,
            reason: input.reason,
            ipAddress: input.ipAddress,
          },
        });
        return { request: rejected, account: null };
      }

      const data = fullReq.proposedData as {
        bankName?: string;
        bankCode?: string;
        accountNumber?: string;
        accountName?: string;
        isDefault?: boolean;
        isActive?: boolean;
      };

      let account;
      if (fullReq.actionType === "CREATE") {
        if (!data.bankName || !data.accountNumber || !data.accountName) {
          throw new VerificationError(400, "INVALID_PROPOSED_DATA", "bankName, accountNumber, and accountName are required.");
        }
        if (data.isDefault) {
          await tx.receivingBankAccount.updateMany({
            where: { isDefault: true },
            data: { isDefault: false },
          });
        }
        account = await tx.receivingBankAccount.create({
          data: {
            bankName: data.bankName.trim(),
            bankCode: data.bankCode?.trim() || null,
            accountNumber: data.accountNumber.trim(),
            accountName: data.accountName.trim(),
            ownerPartnerId: partner.id,
            isActive: data.isActive ?? true,
            isDefault: data.isDefault ?? true,
            createdById: fullReq.requestedByUserId,
          },
        });
      } else if (fullReq.actionType === "UPDATE") {
        if (!fullReq.receivingBankAccountId) {
          throw new VerificationError(400, "MISSING_BANK_ACCOUNT_ID", "receivingBankAccountId missing.");
        }
        if (data.isDefault) {
          await tx.receivingBankAccount.updateMany({
            where: { isDefault: true, id: { not: fullReq.receivingBankAccountId } },
            data: { isDefault: false },
          });
        }
        account = await tx.receivingBankAccount.update({
          where: { id: fullReq.receivingBankAccountId },
          data: {
            ...(data.bankName ? { bankName: data.bankName.trim() } : {}),
            ...(data.bankCode !== undefined ? { bankCode: data.bankCode?.trim() || null } : {}),
            ...(data.accountNumber ? { accountNumber: data.accountNumber.trim() } : {}),
            ...(data.accountName ? { accountName: data.accountName.trim() } : {}),
            ...(data.isDefault !== undefined ? { isDefault: data.isDefault } : {}),
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          },
        });
      } else {
        if (!fullReq.receivingBankAccountId) {
          throw new VerificationError(400, "MISSING_BANK_ACCOUNT_ID", "receivingBankAccountId missing.");
        }
        account = await tx.receivingBankAccount.update({
          where: { id: fullReq.receivingBankAccountId },
          data: { isActive: false, isDefault: false },
        });
      }

      const approvedReq = await tx.receivingBankAccountChangeRequest.update({
        where: { id: fullReq.id },
        data: {
          receivingBankAccountId: account.id,
          status: BankAccountChangeRequestStatus.APPROVED,
          confirmedByUserId: input.partnerUserId,
          confirmationReason: input.reason,
          confirmedAt: now,
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: input.partnerUserId,
          actionType: "RECEIVING_BANK_ACCOUNT_CHANGE_CONFIRMED",
          targetEntity: "receiving_bank_accounts",
          targetId: account.id,
          afterState: {
            requestId: approvedReq.id,
            bankName: account.bankName,
            accountNumber: account.accountNumber,
            accountName: account.accountName,
            isActive: account.isActive,
          },
          reason: input.reason,
          ipAddress: input.ipAddress,
        },
      });

      return { request: approvedReq, account };
    }, { maxWait: 15000, timeout: 30000 });
  }

  // --- Customer Payment Instructions & Proof Submission ---

  async getPaymentInstructionsForOrder(orderId: string, customerUserId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { userId: customerUserId },
    });
    if (!customer) {
      throw new VerificationError(404, "CUSTOMER_NOT_FOUND", "Customer profile not found.");
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });
    if (!order || order.customerId !== customer.id) {
      throw new VerificationError(404, "ORDER_NOT_FOUND", "Order not found.");
    }

    const accounts = await this.prisma.receivingBankAccount.findMany({
      where: { isActive: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      select: {
        id: true,
        bankName: true,
        accountNumber: true,
        accountName: true,
        isDefault: true,
      },
    });

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      paymentReference: order.paymentReference,
      fiatAmountKobo: order.fiatAmountKobo.toString(),
      verifiedGrossFiatKobo: order.verifiedGrossFiatKobo.toString(),
      status: order.status,
      expiresAt: order.expiresAt?.toISOString() ?? null,
      receivingAccounts: accounts,
    };
  }

  async submitPaymentProof(input: {
    orderId: string;
    customerUserId: string;
    receivingBankAccountId: string;
    bankReference: string;
    senderAccountName: string;
    claimedAmountKobo: bigint;
    transferTimestamp?: string;
    proofFileKey: string;
    proofMimeType?: string;
    proofSha256?: string;
    isSplitTransfer?: boolean;
  }) {
    if (input.claimedAmountKobo <= 0n) {
      throw new VerificationError(400, "INVALID_AMOUNT", "Claimed amount must be positive.");
    }

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({
        where: { userId: input.customerUserId },
      });
      if (!customer) {
        throw new VerificationError(404, "CUSTOMER_NOT_FOUND", "Customer profile not found.");
      }

      const lockedOrders = await tx.$queryRaw<
        Array<{ id: string; customer_id: string; status: OrderStatus; expires_at: Date | null; order_number: string }>
      >`
        SELECT id, customer_id, status, expires_at, order_number
        FROM orders
        WHERE id = ${input.orderId}::uuid
        FOR UPDATE
      `;
      const order = lockedOrders[0];
      if (!order || order.customer_id !== customer.id) {
        throw new VerificationError(404, "ORDER_NOT_FOUND", "Order not found.");
      }

      const submittableStatuses: OrderStatus[] = [
        OrderStatus.AWAITING_PAYMENT,
        OrderStatus.PAYMENT_SUBMITTED,
        OrderStatus.PAYMENT_EXCEPTION_REVIEW,
      ];
      if (!submittableStatuses.includes(order.status)) {
        throw new VerificationError(
          409,
          "ORDER_NOT_ACCEPTING_PROOF",
          `Cannot submit payment proof while order is in status ${order.status}.`
        );
      }

      if (order.expires_at && order.expires_at <= now) {
        throw new VerificationError(
          409,
          "RESERVATION_EXPIRED",
          "Order reservation has expired. Please create a new order with a fresh reservation."
        );
      }

      const bankAccount = await tx.receivingBankAccount.findUnique({
        where: { id: input.receivingBankAccountId },
      });
      if (!bankAccount || !bankAccount.isActive) {
        throw new VerificationError(400, "INVALID_RECEIVING_ACCOUNT", "Selected receiving bank account is not active.");
      }

      const proof = await tx.paymentProof.create({
        data: {
          orderId: order.id,
          receivingBankAccountId: bankAccount.id,
          submittedByUserId: input.customerUserId,
          bankName: bankAccount.bankName,
          bankReference: input.bankReference.trim(),
          senderAccountName: input.senderAccountName.trim(),
          claimedAmountKobo: input.claimedAmountKobo,
          transferTimestamp: input.transferTimestamp ? new Date(input.transferTimestamp) : null,
          proofFileKey: input.proofFileKey.trim(),
          proofMimeType: input.proofMimeType?.trim() || null,
          proofSha256: input.proofSha256?.trim() || null,
          isSplitTransfer: input.isSplitTransfer ?? false,
          verificationStatus: ProofVerificationStatus.PENDING,
        },
      });

      const nextStatus =
        order.status === OrderStatus.AWAITING_PAYMENT
          ? OrderStatus.PAYMENT_SUBMITTED
          : order.status;

      const updatedOrder = await tx.order.update({
        where: { id: order.id },
        data: { status: nextStatus },
      });

      const verifierIds = await this.getAuthorizedVerifierUserIds(tx);
      await this.notificationService.createInTx(tx, {
        recipientUserIds: verifierIds,
        type:
          nextStatus === OrderStatus.PAYMENT_EXCEPTION_REVIEW
            ? NotificationType.PAYMENT_EXCEPTION_REVIEW
            : NotificationType.PAYMENT_AWAITING_REVIEW,
        orderId: order.id,
        title: `Payment awaiting verification (${order.order_number})`,
        message: `Supporting proof submitted for ${order.order_number} (ref: ${input.bankReference.trim()}). Confirm actual bank credit before approving.`,
      });

      return { proof, order: updatedOrder };
    }, { maxWait: 15000, timeout: 30000 });
  }

  // --- Statement Upload (Server-Side Validation, Never Auto-Approves) ---

  async uploadStatement(input: {
    actorUserId: string;
    receivingBankAccountId: string;
    fileName: string;
    format: BankStatementFormat;
    periodStart?: string;
    periodEnd?: string;
    notes?: string;
    lines: StatementLineInput[];
    ipAddress?: string;
  }) {
    const bankAccount = await this.prisma.receivingBankAccount.findUnique({
      where: { id: input.receivingBankAccountId },
    });
    if (!bankAccount || !bankAccount.isActive) {
      throw new VerificationError(400, "INVALID_RECEIVING_ACCOUNT", "Active receiving bank account required.");
    }

    if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > MAX_STATEMENT_LINES) {
      throw new VerificationError(
        400,
        "INVALID_STATEMENT_SIZE",
        `Statement must contain between 1 and ${MAX_STATEMENT_LINES} lines.`
      );
    }

    const byteSize = Buffer.byteLength(JSON.stringify(input.lines), "utf8");
    if (byteSize > MAX_STATEMENT_BYTES) {
      throw new VerificationError(400, "STATEMENT_TOO_LARGE", "Statement payload exceeds 2 MB limit.");
    }

    const seenRefs = new Set<string>();
    const validatedLines = input.lines.map((raw, idx) => {
      const refRaw = sanitizeCsvCell(raw.transactionReference ?? "");
      const refNorm = normalizeBankReference(refRaw);
      if (!refNorm || refNorm.length < 3) {
        throw new VerificationError(400, "INVALID_STATEMENT_LINE", `Line ${idx + 1}: valid transactionReference required.`);
      }
      if (seenRefs.has(refNorm)) {
        throw new VerificationError(
          409,
          "DUPLICATE_STATEMENT_REFERENCE",
          `Duplicate transaction reference ${refRaw} within uploaded batch.`
        );
      }
      seenRefs.add(refNorm);

      if (!/^\d+$/.test(raw.amountKobo ?? "")) {
        throw new VerificationError(400, "INVALID_STATEMENT_LINE", `Line ${idx + 1}: integer amountKobo required.`);
      }
      const amountKobo = BigInt(raw.amountKobo);
      if (amountKobo <= 0n) {
        throw new VerificationError(400, "INVALID_STATEMENT_LINE", `Line ${idx + 1}: amountKobo must be > 0.`);
      }

      const creditedAt = new Date(raw.creditedAt);
      if (Number.isNaN(creditedAt.getTime())) {
        throw new VerificationError(400, "INVALID_STATEMENT_LINE", `Line ${idx + 1}: valid creditedAt timestamp required.`);
      }

      return {
        transactionReference: refRaw,
        transactionReferenceNormalized: refNorm,
        amountKobo,
        creditedAt,
        senderName: raw.senderName ? sanitizeCsvCell(raw.senderName) : null,
        narration: raw.narration ? sanitizeCsvCell(raw.narration) : null,
      };
    });

    // Recompute batch sha256 strictly server-side
    const canonicalJson = JSON.stringify(
      validatedLines.map((l) => ({
        ref: l.transactionReferenceNormalized,
        kobo: l.amountKobo.toString(),
        at: l.creditedAt.toISOString(),
      }))
    );
    const serverSha256 = crypto.createHash("sha256").update(canonicalJson).digest("hex");

    try {
      return await this.prisma.$transaction(async (tx) => {
        const upload = await tx.bankStatementUpload.create({
          data: {
            receivingBankAccountId: bankAccount.id,
            uploadedByUserId: input.actorUserId,
            fileName: sanitizeCsvCell(input.fileName).slice(0, 180),
            format: input.format,
            redactedBatchSha256: serverSha256,
            periodStart: input.periodStart ? new Date(input.periodStart) : null,
            periodEnd: input.periodEnd ? new Date(input.periodEnd) : null,
            lineCount: validatedLines.length,
            notes: input.notes?.trim() || null,
          },
        });

        await tx.bankStatementLine.createMany({
          data: validatedLines.map((l) => ({
            statementUploadId: upload.id,
            receivingBankAccountId: bankAccount.id,
            transactionReference: l.transactionReference,
            transactionReferenceNormalized: l.transactionReferenceNormalized,
            amountKobo: l.amountKobo,
            creditedAt: l.creditedAt,
            senderName: l.senderName,
            narration: l.narration,
            reconciliationStatus: BankStatementLineStatus.UNMATCHED,
            linkedOrderId: null,
          })),
        });

        const lines = await tx.bankStatementLine.findMany({
          where: { statementUploadId: upload.id },
          orderBy: { creditedAt: "asc" },
        });

        await tx.auditLog.create({
          data: {
            actorUserId: input.actorUserId,
            actionType: "STATEMENT_UPLOADED",
            targetEntity: "bank_statement_uploads",
            targetId: upload.id,
            afterState: {
              receivingBankAccountId: bankAccount.id,
              lineCount: validatedLines.length,
              redactedBatchSha256: serverSha256,
            },
            reason: input.notes?.trim() || "Redacted OPay statement uploaded for reconciliation",
            ipAddress: input.ipAddress,
          },
        });

        return { upload, lines };
      }, { maxWait: 15000, timeout: 30000 });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new VerificationError(
          409,
          "DUPLICATE_STATEMENT_REFERENCE",
          "One or more statement transaction references have already been uploaded for this receiving bank account."
        );
      }
      throw err;
    }
  }

  // --- Shared Verification Queue ---

  async getVerificationQueue() {
    const orders = await this.prisma.order.findMany({
      where: {
        status: {
          in: [
            OrderStatus.PAYMENT_SUBMITTED,
            OrderStatus.PAYMENT_EXCEPTION_REVIEW,
            OrderStatus.PAYMENT_VERIFIED,
            OrderStatus.READY_FOR_FULFILMENT,
          ],
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: {
        customer: { select: { id: true, fullName: true, category: true } },
        partner: { select: { id: true, displayName: true, referralCode: true } },
        paymentProofs: { orderBy: { createdAt: "asc" } },
        verificationDecisions: {
          orderBy: { createdAt: "asc" },
          include: {
            verifier: { select: { id: true, email: true, role: true } },
            statementLines: {
              include: {
                statementLine: {
                  select: {
                    id: true,
                    transactionReference: true,
                    amountKobo: true,
                    creditedAt: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    return orders.map((o) => {
      const lastDecision =
        o.verificationDecisions[o.verificationDecisions.length - 1] ?? null;
      return {
        id: o.id,
        orderNumber: o.orderNumber,
        paymentReference: o.paymentReference,
        status: o.status,
        paymentExceptionType: o.paymentExceptionType,
        fiatAmountKobo: o.fiatAmountKobo.toString(),
        verifiedGrossFiatKobo: o.verifiedGrossFiatKobo.toString(),
        fundingCycle: o.fundingCycle,
        expiresAt: o.expiresAt?.toISOString() ?? null,
        customer: o.customer,
        partner: o.partner,
        lastActedBy: lastDecision
          ? {
              userId: lastDecision.verifier.id,
              email: lastDecision.verifier.email,
              role: lastDecision.verifier.role,
              decision: lastDecision.decision,
              actedAt: lastDecision.createdAt.toISOString(),
            }
          : null,
        proofs: o.paymentProofs.map((p) => ({
          id: p.id,
          bankName: p.bankName,
          bankReference: p.bankReference,
          senderAccountName: p.senderAccountName,
          claimedAmountKobo: p.claimedAmountKobo.toString(),
          isSplitTransfer: p.isSplitTransfer,
          verificationStatus: p.verificationStatus,
          createdAt: p.createdAt.toISOString(),
        })),
        decisions: o.verificationDecisions.map((d) => ({
          id: d.id,
          decision: d.decision,
          exceptionType: d.exceptionType,
          bankCreditConfirmed: d.bankCreditConfirmed,
          bankCreditReference: d.bankCreditReference,
          bankCreditAmountKobo: d.bankCreditAmountKobo?.toString() ?? null,
          isManualWithoutStatement: d.isManualWithoutStatement,
          reason: d.reason,
          supersedesDecisionId: d.supersedesDecisionId,
          verifier: d.verifier,
          createdAt: d.createdAt.toISOString(),
          statementLines: d.statementLines.map((sl) => ({
            statementLineId: sl.statementLineId,
            allocatedAmountKobo: sl.allocatedAmountKobo.toString(),
            transactionReference: sl.statementLine.transactionReference,
          })),
        })),
      };
    });
  }

  // --- Approve Payment (Supports Multi-Line & Cumulative Split Payments) ---

  async approveOrderPayment(input: {
    orderId: string;
    verifierUserId: string;
    verifierRole: UserRole;
    receivingBankAccountId: string;
    paymentProofId?: string;
    statementLineIds?: string[];
    manualVerificationException?: boolean;
    bankCreditConfirmed: boolean;
    bankCreditReference?: string;
    bankCreditAmountKobo?: bigint;
    bankCreditTimestamp?: string;
    allowExcessResolution?: boolean;
    reason: string;
    ipAddress?: string;
  }) {
    if (!input.bankCreditConfirmed) {
      throw new VerificationError(
        400,
        "BANK_CREDIT_CONFIRMATION_REQUIRED",
        "Verifier must explicitly confirm actual bank credit."
      );
    }

    const statementLineIds = Array.from(new Set(input.statementLineIds ?? []));
    const isManualWithoutStatement = statementLineIds.length === 0;
    if (isManualWithoutStatement) {
      if (!input.manualVerificationException || input.reason.trim().length < 10) {
        throw new VerificationError(
          400,
          "MANUAL_VERIFICATION_EXCEPTION_REQUIRED",
          "Approval without a linked statement line requires manualVerificationException=true and a reason (>=10 chars)."
        );
      }
      if (!input.bankCreditReference || !input.bankCreditAmountKobo || input.bankCreditAmountKobo <= 0n) {
        throw new VerificationError(
          400,
          "BANK_CREDIT_DETAILS_REQUIRED",
          "bankCreditReference and positive bankCreditAmountKobo are required."
        );
      }
    }

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const lockedOrders = await tx.$queryRaw<
            Array<{
              id: string;
              order_number: string;
              customer_id: string;
              status: OrderStatus;
              fiat_amount_kobo: bigint;
              funding_cycle: number;
            }>
          >`
            SELECT id, order_number, customer_id, status, fiat_amount_kobo, funding_cycle
            FROM orders
            WHERE id = ${input.orderId}::uuid
            FOR UPDATE
          `;
          const order = lockedOrders[0];
          if (!order) {
            throw new VerificationError(404, "ORDER_NOT_FOUND", "Order not found.");
          }

          if (
            order.status !== OrderStatus.PAYMENT_SUBMITTED &&
            order.status !== OrderStatus.PAYMENT_EXCEPTION_REVIEW
          ) {
            throw new VerificationError(
              409,
              "INVALID_ORDER_STATE",
              `Order ${order.order_number} cannot be approved in status ${order.status}.`
            );
          }

          const bankAccount = await tx.receivingBankAccount.findUnique({
            where: { id: input.receivingBankAccountId },
          });
          if (!bankAccount || !bankAccount.isActive) {
            throw new VerificationError(400, "INVALID_RECEIVING_ACCOUNT", "Receiving bank account is not active.");
          }

          let decisionAmountKobo: bigint;
          let decisionRefRaw: string;
          let decisionRefNorm: string;
          let decisionTimestamp: Date;
          let lockedLines: Array<{
            id: string;
            receiving_bank_account_id: string;
            transaction_reference: string;
            transaction_reference_normalized: string;
            amount_kobo: bigint;
            credited_at: Date;
            reconciliation_status: BankStatementLineStatus;
            linked_order_id: string | null;
          }> = [];

          if (!isManualWithoutStatement) {
            lockedLines = await tx.$queryRaw`
              SELECT id, receiving_bank_account_id, transaction_reference, transaction_reference_normalized, amount_kobo, credited_at, reconciliation_status, linked_order_id
              FROM bank_statement_lines
              WHERE id = ANY(${statementLineIds}::uuid[])
              ORDER BY id ASC
              FOR UPDATE
            `;

            if (lockedLines.length !== statementLineIds.length) {
              throw new VerificationError(404, "STATEMENT_LINE_NOT_FOUND", "One or more statement lines not found.");
            }

            let sumKobo = 0n;
            for (const line of lockedLines) {
              if (line.receiving_bank_account_id !== bankAccount.id) {
                throw new VerificationError(
                  400,
                  "STATEMENT_ACCOUNT_MISMATCH",
                  "Statement line belongs to a different receiving bank account."
                );
              }
              if (
                line.reconciliation_status !== BankStatementLineStatus.UNMATCHED ||
                line.linked_order_id !== null
              ) {
                throw new VerificationError(
                  409,
                  "STATEMENT_LINE_ALREADY_ALLOCATED",
                  `Statement line ${line.transaction_reference} is already permanently allocated to an order.`
                );
              }
              sumKobo += BigInt(line.amount_kobo);
            }

            decisionAmountKobo = sumKobo;
            decisionRefRaw =
              input.bankCreditReference?.trim() ||
              lockedLines.map((l) => l.transaction_reference).join("+");
            decisionRefNorm =
              lockedLines.length === 1
                ? lockedLines[0].transaction_reference_normalized
                : normalizeBankReference(decisionRefRaw);
            decisionTimestamp = lockedLines[0].credited_at;
          } else {
            decisionAmountKobo = input.bankCreditAmountKobo!;
            decisionRefRaw = input.bankCreditReference!.trim();
            decisionRefNorm = normalizeBankReference(decisionRefRaw);
            decisionTimestamp = input.bankCreditTimestamp
              ? new Date(input.bankCreditTimestamp)
              : new Date();
          }

          if (!decisionRefNorm) {
            throw new VerificationError(400, "INVALID_BANK_REFERENCE", "Valid bank credit reference required.");
          }

          // Compute existing non-reversed APPROVED credits on this order BEFORE adding this decision
          const existingDecisions = await tx.paymentVerificationDecision.findMany({
            where: { orderId: order.id },
            orderBy: { createdAt: "asc" },
          });
          const reversedIds = new Set(
            existingDecisions
              .filter((d) => d.decision === VerificationDecisionType.REVERSED && d.supersedesDecisionId)
              .map((d) => d.supersedesDecisionId!)
          );
          let priorActiveCredits = 0n;
          for (const d of existingDecisions) {
            if (d.decision === VerificationDecisionType.APPROVED && !reversedIds.has(d.id)) {
              priorActiveCredits += d.bankCreditAmountKobo ?? 0n;
            }
          }

          const cumulativeCredits = priorActiveCredits + decisionAmountKobo;
          const requiredKobo = BigInt(order.fiat_amount_kobo);

          let nextOrderStatus: OrderStatus;
          let nextExceptionType: PaymentExceptionType = PaymentExceptionType.NONE;

          if (cumulativeCredits < requiredKobo) {
            nextOrderStatus = OrderStatus.PAYMENT_EXCEPTION_REVIEW;
            nextExceptionType =
              priorActiveCredits > 0n || lockedLines.length > 1
                ? PaymentExceptionType.SPLIT_TRANSFER
                : PaymentExceptionType.PARTIAL_PAYMENT;
          } else if (cumulativeCredits > requiredKobo && !input.allowExcessResolution) {
            nextOrderStatus = OrderStatus.PAYMENT_EXCEPTION_REVIEW;
            nextExceptionType = PaymentExceptionType.EXCESS_PAYMENT;
          } else {
            nextOrderStatus = OrderStatus.READY_FOR_FULFILMENT;
            nextExceptionType = PaymentExceptionType.NONE;
          }

          const decision = await tx.paymentVerificationDecision.create({
            data: {
              orderId: order.id,
              paymentProofId: input.paymentProofId ?? null,
              receivingBankAccountId: bankAccount.id,
              verifierUserId: input.verifierUserId,
              verifierRole: input.verifierRole,
              decision: VerificationDecisionType.APPROVED,
              exceptionType: nextExceptionType,
              bankCreditConfirmed: true,
              bankCreditReference: decisionRefRaw,
              bankCreditReferenceNormalized: decisionRefNorm,
              bankCreditAmountKobo: decisionAmountKobo,
              bankCreditTimestamp: decisionTimestamp,
              isManualWithoutStatement,
              reason: input.reason.trim(),
            },
          });

          for (const line of lockedLines) {
            await tx.paymentDecisionStatementLine.create({
              data: {
                decisionId: decision.id,
                statementLineId: line.id,
                orderId: order.id,
                allocatedAmountKobo: line.amount_kobo,
              },
            });

            await tx.bankStatementLine.update({
              where: { id: line.id },
              data: {
                reconciliationStatus: BankStatementLineStatus.LINKED,
                linkedOrderId: order.id,
              },
            });
          }

          if (input.paymentProofId) {
            await tx.paymentProof.update({
              where: { id: input.paymentProofId },
              data: {
                verificationStatus: ProofVerificationStatus.APPROVED,
                verifiedById: input.verifierUserId,
                verifiedAt: new Date(),
              },
            });
          }

          const updatedOrder = await tx.order.update({
            where: { id: order.id },
            data: {
              status: nextOrderStatus,
              paymentExceptionType: nextExceptionType,
              verifiedGrossFiatKobo: cumulativeCredits,
              ...(nextOrderStatus === OrderStatus.READY_FOR_FULFILMENT ? { expiresAt: null } : {}),
            },
          });

          if (nextOrderStatus === OrderStatus.READY_FOR_FULFILMENT) {
            await tx.inventoryReservation.updateMany({
              where: { orderId: order.id, status: InventoryReservationStatus.ACTIVE },
              data: { expiresAt: null },
            });

            await this.commissionService.accrueForVerifiedOrderInTx(tx, {
              orderId: order.id,
              verifiedByUserId: input.verifierUserId,
              grossFiatKobo: cumulativeCredits,
              fundingCycle: order.funding_cycle,
              reference: decision.id,
            });
          }

          const customer = await tx.customer.findUnique({
            where: { id: order.customer_id },
            select: { userId: true },
          });
          if (customer?.userId) {
            await this.notificationService.createInTx(tx, {
              recipientUserIds: [customer.userId],
              type:
                nextOrderStatus === OrderStatus.READY_FOR_FULFILMENT
                  ? NotificationType.PAYMENT_APPROVED
                  : NotificationType.PAYMENT_EXCEPTION_REVIEW,
              orderId: order.id,
              title:
                nextOrderStatus === OrderStatus.READY_FOR_FULFILMENT
                  ? `Payment verified (${order.order_number})`
                  : `Partial/exception payment recorded (${order.order_number})`,
              message:
                nextOrderStatus === OrderStatus.READY_FOR_FULFILMENT
                  ? `Your payment for ${order.order_number} is verified and ready for fulfilment.`
                  : `Credit recorded for ${order.order_number}. Cumulative verified: ${cumulativeCredits.toString()} kobo; required: ${requiredKobo.toString()} kobo.`,
            });
          }

          await tx.auditLog.create({
            data: {
              actorUserId: input.verifierUserId,
              actionType: isManualWithoutStatement
                ? "PAYMENT_APPROVED_WITHOUT_STATEMENT_LINE"
                : nextOrderStatus === OrderStatus.READY_FOR_FULFILMENT
                ? "PAYMENT_VERIFIED_AND_READY"
                : "PAYMENT_PARTIAL_CREDIT_RECORDED",
              targetEntity: "payment_verification_decisions",
              targetId: decision.id,
              beforeState: { status: order.status, priorActiveCredits: priorActiveCredits.toString() },
              afterState: {
                status: nextOrderStatus,
                exceptionType: nextExceptionType,
                decisionAmountKobo: decisionAmountKobo.toString(),
                cumulativeCredits: cumulativeCredits.toString(),
                statementLineIds,
              },
              reason: input.reason.trim(),
              ipAddress: input.ipAddress,
            },
          });

          return { decision, order: updatedOrder, cumulativeCredits: cumulativeCredits.toString() };
        },
        { maxWait: 15000, timeout: 30000 }
      );
    } catch (err) {
      if (err instanceof VerificationError) throw err;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new VerificationError(
          409,
          "DUPLICATE_BANK_CREDIT",
          "Bank credit reference or statement line has already been permanently allocated to a verified payment."
        );
      }
      throw err;
    }
  }

  // --- Reject Payment (Restores AWAITING_PAYMENT only if reservation is still valid) ---

  async rejectOrderPayment(input: {
    orderId: string;
    verifierUserId: string;
    verifierRole: UserRole;
    paymentProofId?: string;
    reason: string;
    ipAddress?: string;
  }) {
    const now = new Date();
    return this.prisma.$transaction(
      async (tx) => {
        const lockedAccounts = await tx.$queryRaw<
          Array<{
            id: string;
            slot_code: string;
            last_known_balance: string;
            reserved_for_orders: string;
          }>
        >`
          SELECT id, slot_code, last_known_balance::text, reserved_for_orders::text
          FROM game_accounts
          ORDER BY slot_code ASC
          FOR UPDATE
        `;
        const accountMap = new Map(lockedAccounts.map((a) => [a.id, a]));

        const lockedOrders = await tx.$queryRaw<
          Array<{
            id: string;
            order_number: string;
            customer_id: string;
            status: OrderStatus;
            expires_at: Date | null;
          }>
        >`
          SELECT id, order_number, customer_id, status, expires_at
          FROM orders
          WHERE id = ${input.orderId}::uuid
          FOR UPDATE
        `;
        const order = lockedOrders[0];
        if (!order) {
          throw new VerificationError(404, "ORDER_NOT_FOUND", "Order not found.");
        }
        if (
          order.status !== OrderStatus.PAYMENT_SUBMITTED &&
          order.status !== OrderStatus.PAYMENT_EXCEPTION_REVIEW
        ) {
          throw new VerificationError(
            409,
            "INVALID_ORDER_STATE",
            `Order ${order.order_number} cannot be rejected in status ${order.status}.`
          );
        }

        const decision = await tx.paymentVerificationDecision.create({
          data: {
            orderId: order.id,
            paymentProofId: input.paymentProofId ?? null,
            verifierUserId: input.verifierUserId,
            verifierRole: input.verifierRole,
            decision: VerificationDecisionType.REJECTED,
            exceptionType: PaymentExceptionType.NONE,
            bankCreditConfirmed: false,
            reason: input.reason.trim(),
          },
        });

        if (input.paymentProofId) {
          await tx.paymentProof.update({
            where: { id: input.paymentProofId },
            data: {
              verificationStatus: ProofVerificationStatus.REJECTED,
              verifiedById: input.verifierUserId,
              rejectionReason: input.reason.trim(),
              verifiedAt: now,
            },
          });
        } else {
          await tx.paymentProof.updateMany({
            where: { orderId: order.id, verificationStatus: ProofVerificationStatus.PENDING },
            data: {
              verificationStatus: ProofVerificationStatus.REJECTED,
              verifiedById: input.verifierUserId,
              rejectionReason: input.reason.trim(),
              verifiedAt: now,
            },
          });
        }

        const reservationStillValid = !order.expires_at || order.expires_at > now;
        let nextStatus: OrderStatus;

        if (reservationStillValid) {
          nextStatus = OrderStatus.AWAITING_PAYMENT;
        } else {
          nextStatus = OrderStatus.EXPIRED;
          const activeReservations = await tx.inventoryReservation.findMany({
            where: { orderId: order.id, status: InventoryReservationStatus.ACTIVE },
          });
          for (const res of activeReservations) {
            const resAmount = BigInt(res.amount.toFixed(0));
            await tx.inventoryReservation.update({
              where: { id: res.id },
              data: {
                status: InventoryReservationStatus.EXPIRED,
                releasedAt: now,
                releaseReason: "REJECTED_AFTER_RESERVATION_EXPIRY",
              },
            });
            const acc = accountMap.get(res.gameAccountId);
            if (acc) {
              const observed = BigInt(acc.last_known_balance.split(".")[0] ?? "0");
              const prevReserved = BigInt(acc.reserved_for_orders.split(".")[0] ?? "0");
              const nextReserved = prevReserved > resAmount ? prevReserved - resAmount : 0n;
              acc.reserved_for_orders = nextReserved.toString();
              await tx.gameAccount.update({
                where: { id: acc.id },
                data: { reservedForOrders: nextReserved.toString() },
              });
              await tx.inventoryLedger.create({
                data: {
                  gameAccountId: acc.id,
                  orderId: order.id,
                  entryType: InventoryEntryType.ORDER_RELEASE,
                  deltaAmount: resAmount.toString(),
                  balanceAfter: (observed > nextReserved ? observed - nextReserved : 0n).toString(),
                  createdById: input.verifierUserId,
                  notes: `Released expired reservation upon payment rejection (${order.order_number})`,
                },
              });
            }
          }
        }

        const updatedOrder = await tx.order.update({
          where: { id: order.id },
          data: { status: nextStatus },
        });

        const customer = await tx.customer.findUnique({
          where: { id: order.customer_id },
          select: { userId: true },
        });
        if (customer?.userId) {
          await this.notificationService.createInTx(tx, {
            recipientUserIds: [customer.userId],
            type: NotificationType.PAYMENT_REJECTED,
            orderId: order.id,
            title: `Payment rejected (${order.order_number})`,
            message: reservationStillValid
              ? `Payment rejected (${input.reason.trim()}). Your inventory reservation is still active; please submit valid payment proof before expiry.`
              : `Payment rejected (${input.reason.trim()}) and your reservation has expired. Please place a new order for a fresh reservation.`,
          });
        }

        await tx.auditLog.create({
          data: {
            actorUserId: input.verifierUserId,
            actionType: "PAYMENT_REJECTED",
            targetEntity: "payment_verification_decisions",
            targetId: decision.id,
            beforeState: { status: order.status },
            afterState: { status: nextStatus, reservationStillValid },
            reason: input.reason.trim(),
            ipAddress: input.ipAddress,
          },
        });

        return { decision, order: updatedOrder, reservationStillValid };
      },
      { maxWait: 15000, timeout: 30000 }
    );
  }

  // --- Full Reversal Only (Owner-Only, Single-Reversal DB Guarantee, Restores Expiry) ---

  async reverseApprovedDecision(input: {
    orderId: string;
    decisionId: string;
    ownerUserId: string;
    reversalAmountKobo?: bigint;
    reason: string;
    ipAddress?: string;
  }) {
    const now = new Date();
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const lockedOrders = await tx.$queryRaw<
            Array<{
              id: string;
              order_number: string;
              customer_id: string;
              status: OrderStatus;
              fiat_amount_kobo: bigint;
              funding_cycle: number;
            }>
          >`
            SELECT id, order_number, customer_id, status, fiat_amount_kobo, funding_cycle
            FROM orders
            WHERE id = ${input.orderId}::uuid
            FOR UPDATE
          `;
          const order = lockedOrders[0];
          if (!order) {
            throw new VerificationError(404, "ORDER_NOT_FOUND", "Order not found.");
          }

          const lockedDecisions = await tx.$queryRaw<
            Array<{
              id: string;
              order_id: string;
              decision: VerificationDecisionType;
              bank_credit_amount_kobo: bigint | null;
              receiving_bank_account_id: string | null;
              bank_credit_reference: string | null;
              bank_credit_reference_normalized: string | null;
            }>
          >`
            SELECT id, order_id, decision, bank_credit_amount_kobo, receiving_bank_account_id, bank_credit_reference, bank_credit_reference_normalized
            FROM payment_verification_decisions
            WHERE id = ${input.decisionId}::uuid
            FOR UPDATE
          `;
          const original = lockedDecisions[0];
          if (!original || original.order_id !== order.id) {
            throw new VerificationError(404, "DECISION_NOT_FOUND", "Verification decision not found for this order.");
          }
          if (original.decision !== VerificationDecisionType.APPROVED) {
            throw new VerificationError(400, "INVALID_DECISION_TYPE", "Only APPROVED decisions can be reversed.");
          }

          const origAmount = BigInt(original.bank_credit_amount_kobo ?? 0n);
          if (input.reversalAmountKobo !== undefined && input.reversalAmountKobo !== origAmount) {
            throw new VerificationError(
              400,
              "PARTIAL_REVERSAL_UNSUPPORTED",
              `Phase 5 supports full reversals only. Reversal amount must equal ${origAmount.toString()} kobo.`
            );
          }

          const reversalDecision = await tx.paymentVerificationDecision.create({
            data: {
              orderId: order.id,
              receivingBankAccountId: original.receiving_bank_account_id,
              verifierUserId: input.ownerUserId,
              verifierRole: UserRole.OWNER,
              decision: VerificationDecisionType.REVERSED,
              exceptionType: PaymentExceptionType.NONE,
              bankCreditConfirmed: false,
              bankCreditReference: original.bank_credit_reference,
              bankCreditReferenceNormalized: original.bank_credit_reference_normalized,
              bankCreditAmountKobo: origAmount,
              supersedesDecisionId: original.id,
              reason: input.reason.trim(),
            },
          });

          // Note: PaymentDecisionStatementLine & BankStatementLine remain permanently allocated!
          // Reversing does NOT recycle statement lines or normalized bank references.

          const allDecisions = await tx.paymentVerificationDecision.findMany({
            where: { orderId: order.id },
          });
          const reversedSet = new Set(
            allDecisions
              .filter((d) => d.decision === VerificationDecisionType.REVERSED && d.supersedesDecisionId)
              .map((d) => d.supersedesDecisionId!)
          );
          let remainingActiveCredits = 0n;
          for (const d of allDecisions) {
            if (d.decision === VerificationDecisionType.APPROVED && !reversedSet.has(d.id)) {
              remainingActiveCredits += d.bankCreditAmountKobo ?? 0n;
            }
          }

          const requiredKobo = BigInt(order.fiat_amount_kobo);
          let nextStatus = order.status;
          let nextFundingCycle = order.funding_cycle;
          let restoredExpiresAt: Date | null = null;

          if (remainingActiveCredits < requiredKobo) {
            if (
              order.status === OrderStatus.READY_FOR_FULFILMENT ||
              order.status === OrderStatus.PAYMENT_VERIFIED
            ) {
              await this.commissionService.reverseForOrderInTx(tx, {
                orderId: order.id,
                actorUserId: input.ownerUserId,
                fundingCycle: order.funding_cycle,
                reference: reversalDecision.id,
                reason: `Commission reversed due to payment decision reversal: ${input.reason.trim()}`,
              });
              nextFundingCycle = order.funding_cycle + 1;
            }

            nextStatus = OrderStatus.PAYMENT_EXCEPTION_REVIEW;
            const expiryMins = await this.getUnpaidExpiryMinutes(tx);
            restoredExpiresAt =
              expiryMins !== null ? new Date(now.getTime() + expiryMins * 60_000) : null;

            await tx.inventoryReservation.updateMany({
              where: { orderId: order.id, status: InventoryReservationStatus.ACTIVE },
              data: { expiresAt: restoredExpiresAt },
            });
          }

          const updatedOrder = await tx.order.update({
            where: { id: order.id },
            data: {
              status: nextStatus,
              paymentExceptionType:
                remainingActiveCredits < requiredKobo
                  ? PaymentExceptionType.PARTIAL_PAYMENT
                  : PaymentExceptionType.NONE,
              verifiedGrossFiatKobo: remainingActiveCredits,
              fundingCycle: nextFundingCycle,
              ...(remainingActiveCredits < requiredKobo ? { expiresAt: restoredExpiresAt } : {}),
            },
          });

          const customer = await tx.customer.findUnique({
            where: { id: order.customer_id },
            select: { userId: true },
          });
          if (customer?.userId) {
            await this.notificationService.createInTx(tx, {
              recipientUserIds: [customer.userId],
              type: NotificationType.PAYMENT_REVERSED,
              orderId: order.id,
              title: `Payment decision reversed (${order.order_number})`,
              message: `A previously verified credit of ${origAmount.toString()} kobo was reversed (${input.reason.trim()}). Remaining verified credits: ${remainingActiveCredits.toString()} kobo.`,
            });
          }

          await tx.auditLog.create({
            data: {
              actorUserId: input.ownerUserId,
              actionType: "PAYMENT_DECISION_REVERSED",
              targetEntity: "payment_verification_decisions",
              targetId: reversalDecision.id,
              beforeState: {
                originalDecisionId: original.id,
                status: order.status,
                fundingCycle: order.funding_cycle,
              },
              afterState: {
                status: nextStatus,
                remainingActiveCredits: remainingActiveCredits.toString(),
                nextFundingCycle,
                restoredExpiresAt: restoredExpiresAt?.toISOString() ?? null,
              },
              reason: input.reason.trim(),
              ipAddress: input.ipAddress,
            },
          });

          return {
            reversalDecision,
            order: updatedOrder,
            remainingActiveCredits: remainingActiveCredits.toString(),
          };
        },
        { maxWait: 15000, timeout: 30000 }
      );
    } catch (err) {
      if (err instanceof VerificationError) throw err;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new VerificationError(
          409,
          "ALREADY_REVERSED",
          "This payment verification decision has already been reversed."
        );
      }
      throw err;
    }
  }

  // --- Reversal-Aware Financial Accountability (Append-Only Ledger Based) ---

  async getFinancialAccountability() {
    const [statementLines, decisions, ledgerEntries, openOrders, partners] = await Promise.all([
      this.prisma.bankStatementLine.findMany({
        select: { amountKobo: true, reconciliationStatus: true },
      }),
      this.prisma.paymentVerificationDecision.findMany({
        select: {
          decision: true,
          bankCreditAmountKobo: true,
          isManualWithoutStatement: true,
          supersedesDecisionId: true,
        },
      }),
      this.prisma.commissionLedgerEntry.findMany({
        select: {
          partnerId: true,
          entryType: true,
          partnerDeltaKobo: true,
          ownerDeltaKobo: true,
        },
      }),
      this.prisma.order.findMany({
        where: {
          status: {
            in: [
              OrderStatus.AWAITING_PAYMENT,
              OrderStatus.PAYMENT_SUBMITTED,
              OrderStatus.PAYMENT_EXCEPTION_REVIEW,
            ],
          },
        },
        select: {
          fiatAmountKobo: true,
          verifiedGrossFiatKobo: true,
        },
      }),
      this.prisma.partner.findMany({
        select: { id: true, displayName: true, referralCode: true },
      }),
    ]);

    let statementCreditsUploadedKobo = 0n;
    for (const l of statementLines) {
      statementCreditsUploadedKobo += l.amountKobo;
    }

    let approvedGrossKobo = 0n;
    let reversedGrossKobo = 0n;
    let statementLinkedVerifiedCount = 0;
    let manualWithoutStatementCount = 0;

    for (const d of decisions) {
      const amt = d.bankCreditAmountKobo ?? 0n;
      if (d.decision === VerificationDecisionType.APPROVED) {
        approvedGrossKobo += amt;
        if (d.isManualWithoutStatement) manualWithoutStatementCount++;
        else statementLinkedVerifiedCount++;
      } else if (d.decision === VerificationDecisionType.REVERSED) {
        reversedGrossKobo += amt;
      }
    }

    const netVerifiedCustomerPaymentsKobo = approvedGrossKobo - reversedGrossKobo;

    let outstandingBalancesKobo = 0n;
    for (const o of openOrders) {
      const diff = o.fiatAmountKobo - o.verifiedGrossFiatKobo;
      if (diff > 0n) outstandingBalancesKobo += diff;
    }

    const partnerMap = new Map(
      partners.map((p) => [
        p.id,
        {
          partnerId: p.id,
          displayName: p.displayName,
          referralCode: p.referralCode,
          netPartnerEntitlementKobo: 0n,
          netOwnerEntitlementKobo: 0n,
        },
      ])
    );

    let totalNetPartnerEntitlementKobo = 0n;
    let totalNetOwnerEntitlementKobo = 0n;
    for (const e of ledgerEntries) {
      totalNetPartnerEntitlementKobo += e.partnerDeltaKobo;
      totalNetOwnerEntitlementKobo += e.ownerDeltaKobo;
      if (e.partnerId && partnerMap.has(e.partnerId)) {
        const entry = partnerMap.get(e.partnerId)!;
        entry.netPartnerEntitlementKobo += e.partnerDeltaKobo;
        entry.netOwnerEntitlementKobo += e.ownerDeltaKobo;
      }
    }

    return {
      statementTransactionsUploaded: {
        count: statementLines.length,
        totalKobo: statementCreditsUploadedKobo.toString(),
        note: "Informational reconciliation pool only; never counted as verified revenue.",
      },
      paymentsVerified: {
        statementLinkedCount: statementLinkedVerifiedCount,
        manualWithoutStatementCount,
        approvedGrossKobo: approvedGrossKobo.toString(),
        reversedGrossKobo: reversedGrossKobo.toString(),
        netVerifiedCustomerPaymentsKobo: netVerifiedCustomerPaymentsKobo.toString(),
      },
      outstandingBalancesKobo: outstandingBalancesKobo.toString(),
      commissionEntitlements: {
        totalNetPartnerEntitlementKobo: totalNetPartnerEntitlementKobo.toString(),
        totalNetOwnerEntitlementKobo: totalNetOwnerEntitlementKobo.toString(),
        byPartner: Array.from(partnerMap.values()).map((p) => ({
          partnerId: p.partnerId,
          displayName: p.displayName,
          referralCode: p.referralCode,
          netPartnerEntitlementKobo: p.netPartnerEntitlementKobo.toString(),
          netOwnerEntitlementKobo: p.netOwnerEntitlementKobo.toString(),
        })),
      },
    };
  }
}

