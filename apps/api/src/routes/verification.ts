import type { FastifyInstance } from "fastify";
import { BankStatementFormat, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { Permission } from "@bigola/shared";
import { CommissionService } from "../services/commission.js";
import { NotificationService } from "../services/notification.js";
import { VerificationError, VerificationService } from "../services/verification.js";

const statementUploadSchema = z.object({
  receivingBankAccountId: z.string().uuid(),
  fileName: z.string().min(1).max(180),
  format: z.nativeEnum(BankStatementFormat),
  periodStart: z.string().datetime().optional(),
  periodEnd: z.string().datetime().optional(),
  notes: z.string().max(500).optional(),
  lines: z
    .array(
      z.object({
        transactionReference: z.string().min(3).max(120),
        amountKobo: z.string().regex(/^\d+$/),
        creditedAt: z.string().min(4),
        senderName: z.string().max(160).optional(),
        narration: z.string().max(300).optional(),
      })
    )
    .min(1)
    .max(5000),
});

const approvePaymentSchema = z.object({
  receivingBankAccountId: z.string().uuid(),
  paymentProofId: z.string().uuid().optional(),
  statementLineIds: z.array(z.string().uuid()).optional(),
  manualVerificationException: z.boolean().optional(),
  bankCreditConfirmed: z.literal(true),
  bankCreditReference: z.string().min(3).max(120).optional(),
  bankCreditAmountKobo: z.string().regex(/^\d+$/).optional(),
  bankCreditTimestamp: z.string().optional(),
  allowExcessResolution: z.boolean().optional(),
  reason: z.string().min(3).max(500),
});

const rejectPaymentSchema = z.object({
  paymentProofId: z.string().uuid().optional(),
  reason: z.string().min(3).max(500),
});

const reverseDecisionSchema = z.object({
  decisionId: z.string().uuid(),
  reversalAmountKobo: z.string().regex(/^\d+$/).optional(),
  reason: z.string().min(5).max(500),
});

export function registerVerificationRoutes(
  app: FastifyInstance,
  deps: {
    authenticate: ReturnType<typeof import("../middleware/auth.js").createAuthMiddleware>["authenticate"];
    requirePermission: ReturnType<typeof import("../middleware/auth.js").createAuthMiddleware>["requirePermission"];
    prisma?: PrismaClient;
    verificationService?: VerificationService;
  }
) {
  const getService = () => {
    if (deps.verificationService) return deps.verificationService;
    if (deps.prisma) {
      return new VerificationService(
        deps.prisma,
        new CommissionService(deps.prisma),
        new NotificationService(deps.prisma)
      );
    }
    return null;
  };

  const verifierGuard = async (request: Parameters<typeof deps.authenticate>[0], reply: Parameters<typeof deps.authenticate>[1]) => {
    await deps.authenticate(request, reply);
    if (reply.sent) return;
    const svc = getService();
    if (!svc) {
      return reply.code(503).send({ error: "Verification service unavailable." });
    }
    try {
      await svc.assertAuthorizedVerifier(request.auth!.userId, request.auth!.role);
    } catch (err) {
      if (err instanceof VerificationError) {
        return reply.code(err.statusCode).send({ code: err.code, error: err.message });
      }
      throw err;
    }
  };

  app.get("/api/v1/verification/queue", { preHandler: verifierGuard }, async (_request, reply) => {
    const svc = getService()!;
    const orders = await svc.getVerificationQueue();
    return reply.code(200).send({ orders });
  });

  app.get("/api/v1/verification/bank-accounts", { preHandler: verifierGuard }, async (_request, reply) => {
    const svc = getService()!;
    const data = await svc.listBankAccounts();
    return reply.code(200).send(data);
  });

  app.get("/api/v1/verification/statements", { preHandler: verifierGuard }, async (_request, reply) => {
    if (!deps.prisma) {
      return reply.code(503).send({ error: "Database service unavailable." });
    }
    const [uploads, lines] = await Promise.all([
      deps.prisma.bankStatementUpload.findMany({
        orderBy: { createdAt: "desc" },
        take: 25,
        include: {
          uploadedBy: { select: { id: true, email: true, role: true } },
          receivingBankAccount: { select: { id: true, bankName: true, accountNumber: true } },
        },
      }),
      deps.prisma.bankStatementLine.findMany({
        orderBy: { creditedAt: "desc" },
        take: 200,
      }),
    ]);

    return reply.code(200).send({
      uploads: uploads.map((u) => ({
        id: u.id,
        fileName: u.fileName,
        format: u.format,
        redactedBatchSha256: u.redactedBatchSha256,
        lineCount: u.lineCount,
        uploadedBy: u.uploadedBy,
        receivingBankAccount: u.receivingBankAccount,
        createdAt: u.createdAt.toISOString(),
      })),
      lines: lines.map((l) => ({
        id: l.id,
        statementUploadId: l.statementUploadId,
        receivingBankAccountId: l.receivingBankAccountId,
        transactionReference: l.transactionReference,
        amountKobo: l.amountKobo.toString(),
        creditedAt: l.creditedAt.toISOString(),
        senderName: l.senderName,
        narration: l.narration,
        reconciliationStatus: l.reconciliationStatus,
        linkedOrderId: l.linkedOrderId,
      })),
    });
  });

  app.post("/api/v1/verification/statements", { preHandler: verifierGuard }, async (request, reply) => {
    const svc = getService()!;
    const parsed = statementUploadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid statement payload.", issues: parsed.error.issues });
    }
    try {
      const result = await svc.uploadStatement({
        actorUserId: request.auth!.userId,
        receivingBankAccountId: parsed.data.receivingBankAccountId,
        fileName: parsed.data.fileName,
        format: parsed.data.format,
        periodStart: parsed.data.periodStart,
        periodEnd: parsed.data.periodEnd,
        notes: parsed.data.notes,
        lines: parsed.data.lines,
        ipAddress: request.ip,
      });
      return reply.code(201).send({
        upload: {
          id: result.upload.id,
          lineCount: result.upload.lineCount,
          redactedBatchSha256: result.upload.redactedBatchSha256,
          createdAt: result.upload.createdAt.toISOString(),
        },
        lines: result.lines.map((l) => ({
          id: l.id,
          transactionReference: l.transactionReference,
          amountKobo: l.amountKobo.toString(),
          reconciliationStatus: l.reconciliationStatus,
        })),
      });
    } catch (err) {
      if (err instanceof VerificationError) {
        return reply.code(err.statusCode).send({ code: err.code, error: err.message });
      }
      throw err;
    }
  });

  app.post(
    "/api/v1/verification/orders/:orderId/approve",
    { preHandler: verifierGuard },
    async (request, reply) => {
      const svc = getService()!;
      const { orderId } = request.params as { orderId: string };
      const parsed = approvePaymentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid approval payload.", issues: parsed.error.issues });
      }
      try {
        const result = await svc.approveOrderPayment({
          orderId,
          verifierUserId: request.auth!.userId,
          verifierRole: request.auth!.role,
          receivingBankAccountId: parsed.data.receivingBankAccountId,
          paymentProofId: parsed.data.paymentProofId,
          statementLineIds: parsed.data.statementLineIds,
          manualVerificationException: parsed.data.manualVerificationException,
          bankCreditConfirmed: parsed.data.bankCreditConfirmed,
          bankCreditReference: parsed.data.bankCreditReference,
          bankCreditAmountKobo: parsed.data.bankCreditAmountKobo
            ? BigInt(parsed.data.bankCreditAmountKobo)
            : undefined,
          bankCreditTimestamp: parsed.data.bankCreditTimestamp,
          allowExcessResolution: parsed.data.allowExcessResolution,
          reason: parsed.data.reason,
          ipAddress: request.ip,
        });
        return reply.code(200).send({
          decisionId: result.decision.id,
          orderStatus: result.order.status,
          paymentExceptionType: result.order.paymentExceptionType,
          cumulativeCreditsKobo: result.cumulativeCredits,
        });
      } catch (err) {
        if (err instanceof VerificationError) {
          return reply.code(err.statusCode).send({ code: err.code, error: err.message });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/verification/orders/:orderId/reject",
    { preHandler: verifierGuard },
    async (request, reply) => {
      const svc = getService()!;
      const { orderId } = request.params as { orderId: string };
      const parsed = rejectPaymentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Rejection reason is required.", issues: parsed.error.issues });
      }
      try {
        const result = await svc.rejectOrderPayment({
          orderId,
          verifierUserId: request.auth!.userId,
          verifierRole: request.auth!.role,
          paymentProofId: parsed.data.paymentProofId,
          reason: parsed.data.reason,
          ipAddress: request.ip,
        });
        return reply.code(200).send({
          decisionId: result.decision.id,
          orderStatus: result.order.status,
          reservationStillValid: result.reservationStillValid,
        });
      } catch (err) {
        if (err instanceof VerificationError) {
          return reply.code(err.statusCode).send({ code: err.code, error: err.message });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/verification/orders/:orderId/reverse",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_DASHBOARD_VIEW)] },
    async (request, reply) => {
      const svc = getService();
      if (!svc) {
        return reply.code(503).send({ error: "Verification service unavailable." });
      }
      const { orderId } = request.params as { orderId: string };
      const parsed = reverseDecisionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid reversal payload.", issues: parsed.error.issues });
      }
      try {
        const result = await svc.reverseApprovedDecision({
          orderId,
          decisionId: parsed.data.decisionId,
          ownerUserId: request.auth!.userId,
          reversalAmountKobo: parsed.data.reversalAmountKobo
            ? BigInt(parsed.data.reversalAmountKobo)
            : undefined,
          reason: parsed.data.reason,
          ipAddress: request.ip,
        });
        return reply.code(200).send({
          reversalDecisionId: result.reversalDecision.id,
          orderStatus: result.order.status,
          fundingCycle: result.order.fundingCycle,
          remainingActiveCreditsKobo: result.remainingActiveCredits,
        });
      } catch (err) {
        if (err instanceof VerificationError) {
          return reply.code(err.statusCode).send({ code: err.code, error: err.message });
        }
        throw err;
      }
    }
  );

  app.get("/api/v1/verification/accountability", { preHandler: verifierGuard }, async (_request, reply) => {
    const svc = getService()!;
    const report = await svc.getFinancialAccountability();
    return reply.code(200).send(report);
  });
}

