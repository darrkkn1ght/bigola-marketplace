import crypto from "node:crypto";
import {
  CommissionLedgerEntryType,
  InventoryEntryType,
  InventoryReservationStatus,
  NotificationType,
  OrderStatus,
  Prisma,
  PrismaClient,
  RefundFinancialStatus,
  RefundScope,
  RefundStatus,
  UserRole,
} from "@prisma/client";
import { getManualFulfilmentDebitsSinceSync } from "./inventory.js";

export class OperationsError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "OperationsError";
  }
}

function hashCanonicalPayload(payload: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function clampZero(val: bigint): bigint {
  return val > 0n ? val : 0n;
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export class OperationsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly disbursementEnabled: boolean = false
  ) {}

  async getOrderOperationalDetail(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            lagoslifeUsername: true,
            category: true,
          },
        },
        partner: {
          select: {
            id: true,
            displayName: true,
            referralCode: true,
          },
        },
        paymentProofs: { orderBy: { createdAt: "desc" } },
        verificationDecisions: {
          orderBy: { createdAt: "desc" },
          include: {
            verifier: { select: { id: true, email: true, role: true } },
            statementLines: {
              include: {
                statementLine: {
                  select: {
                    id: true,
                    transactionReference: true,
                    amountKobo: true,
                    senderName: true,
                    creditedAt: true,
                  },
                },
              },
            },
          },
        },
        reservations: {
          include: {
            gameAccount: { select: { id: true, slotCode: true } },
          },
        },
        manualFulfilments: {
          orderBy: { confirmedAt: "desc" },
          include: {
            sourceGameAccount: { select: { id: true, slotCode: true } },
            confirmedBy: { select: { id: true, email: true, role: true } },
          },
        },
        refundRequests: {
          orderBy: { createdAt: "desc" },
          include: {
            createdBy: { select: { id: true, email: true } },
            events: {
              orderBy: { createdAt: "asc" },
              include: { actor: { select: { id: true, email: true, role: true } } },
            },
          },
        },
        commissionRecord: {
          include: {
            ledgerEntries: { orderBy: { createdAt: "asc" } },
          },
        },
        supportTickets: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            ticketNumber: true,
            category: true,
            status: true,
            priority: true,
            subject: true,
            createdAt: true,
          },
        },
      },
    });

    if (!order) {
      throw new OperationsError(404, "ORDER_NOT_FOUND", "Order not found.");
    }

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      paymentReference: order.paymentReference,
      channel: order.channel,
      orderType: order.orderType,
      status: order.status,
      paymentExceptionType: order.paymentExceptionType,
      refundFinancialStatus: order.refundFinancialStatus,
      recipientLagoslifeUsername: order.recipientLagoslifeUsername,
      gameAmountRequested: order.gameAmountRequested.toFixed(0),
      gameAmountDelivered: order.gameAmountDelivered.toFixed(0),
      fulfilledAmount: order.fulfilledAmount.toFixed(0),
      fiatAmountKobo: order.fiatAmountKobo.toString(),
      verifiedGrossFiatKobo: order.verifiedGrossFiatKobo.toString(),
      confirmedRefundedKobo: order.confirmedRefundedKobo.toString(),
      fundingCycle: order.fundingCycle,
      expiresAt: order.expiresAt?.toISOString() ?? null,
      createdAt: order.createdAt.toISOString(),
      customer: order.customer,
      partner: order.partner,
      paymentProofs: order.paymentProofs.map((p) => ({
        id: p.id,
        bankName: p.bankName,
        bankReference: p.bankReference,
        senderAccountName: p.senderAccountName,
        claimedAmountKobo: p.claimedAmountKobo.toString(),
        verificationStatus: p.verificationStatus,
        isSplitTransfer: p.isSplitTransfer,
        createdAt: p.createdAt.toISOString(),
      })),
      verificationDecisions: order.verificationDecisions.map((d) => ({
        id: d.id,
        decision: d.decision,
        bankCreditAmountKobo: (d.bankCreditAmountKobo ?? 0n).toString(),
        bankCreditReference: d.bankCreditReference,
        reason: d.reason,
        verifier: d.verifier,
        createdAt: d.createdAt.toISOString(),
        statementLines: d.statementLines.map((sl) => ({
          id: sl.id,
          allocatedAmountKobo: sl.allocatedAmountKobo.toString(),
          transactionReference: sl.statementLine.transactionReference,
        })),
      })),
      reservations: order.reservations.map((r) => ({
        id: r.id,
        gameAccountId: r.gameAccountId,
        slotCode: r.gameAccount.slotCode,
        amount: r.amount.toFixed(0),
        status: r.status,
        expiresAt: r.expiresAt?.toISOString() ?? null,
        releasedAt: r.releasedAt?.toISOString() ?? null,
        releaseReason: r.releaseReason,
      })),
      manualFulfilments: order.manualFulfilments.map((f) => ({
        id: f.id,
        sourceGameAccountId: f.sourceGameAccountId,
        slotCode: f.sourceGameAccount.slotCode,
        deliveredAmount: f.deliveredAmount.toFixed(0),
        externalReference: f.externalReference,
        idempotencyKey: f.idempotencyKey,
        notes: f.notes,
        confirmedBy: f.confirmedBy,
        confirmedAt: f.confirmedAt.toISOString(),
      })),
      refundRequests: order.refundRequests.map((rr) => ({
        id: rr.id,
        scope: rr.scope,
        requestedAmountKobo: rr.requestedAmountKobo.toString(),
        currentStatus: rr.currentStatus,
        confirmedRefundReference: rr.confirmedRefundReference,
        createdBy: rr.createdBy,
        createdAt: rr.createdAt.toISOString(),
        events: rr.events.map((ev) => ({
          id: ev.id,
          eventType: ev.eventType,
          amountKobo: ev.amountKobo.toString(),
          refundReference: ev.refundReference,
          reason: ev.reason,
          actor: ev.actor,
          createdAt: ev.createdAt.toISOString(),
        })),
      })),
      commissionRecord: order.commissionRecord
        ? {
            id: order.commissionRecord.id,
            settlementStatus: order.commissionRecord.settlementStatus,
            ledgerEntries: order.commissionRecord.ledgerEntries.map((e) => ({
              id: e.id,
              fundingCycle: e.fundingCycle,
              entryType: e.entryType,
              partnerDeltaKobo: e.partnerDeltaKobo.toString(),
              ownerDeltaKobo: e.ownerDeltaKobo.toString(),
              reference: e.reference,
              notes: e.notes,
              createdAt: e.createdAt.toISOString(),
            })),
          }
        : null,
      supportTickets: order.supportTickets.map((t) => ({
        ...t,
        createdAt: t.createdAt.toISOString(),
      })),
    };
  }

  async assertFulfilmentAuthority(userId: string, role: UserRole) {
    if (role === UserRole.OWNER) return;
    if (role === UserRole.OPS_ADMIN) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { canConfirmFulfilment: true, isActive: true },
      });
      if (user?.isActive && user.canConfirmFulfilment) return;
    }
    throw new OperationsError(
      403,
      "FORBIDDEN_FULFILMENT",
      "Forbidden: explicit fulfilment confirmation authorization is required."
    );
  }

  async confirmManualFulfilment(input: {
    orderId: string;
    actorUserId: string;
    actorRole: UserRole;
    sourceGameAccountId: string;
    deliveredAmount: bigint;
    externalReference: string;
    idempotencyKey: string;
    notes?: string;
    ipAddress?: string;
  }) {
    if (this.disbursementEnabled) {
      throw new OperationsError(
        409,
        "AUTO_DISBURSEMENT_ENABLED",
        "Manual fulfilment confirmation is disabled while automated disbursement is enabled."
      );
    }

    await this.assertFulfilmentAuthority(input.actorUserId, input.actorRole);

    const extRef = input.externalReference.trim();
    const idemKey = input.idempotencyKey.trim();
    const notes = input.notes?.trim() ?? null;
    if (!extRef || !idemKey) {
      throw new OperationsError(
        400,
        "INVALID_INPUT",
        "externalReference and idempotencyKey are required."
      );
    }
    if (input.deliveredAmount <= 0n) {
      throw new OperationsError(400, "INVALID_AMOUNT", "deliveredAmount must be positive.");
    }

    const requestHash = hashCanonicalPayload({
      orderId: input.orderId,
      sourceGameAccountId: input.sourceGameAccountId,
      deliveredAmount: input.deliveredAmount.toString(),
      externalReference: extRef,
      notes,
    });

    const existingByKey = await this.prisma.manualFulfilmentRecord.findUnique({
      where: { idempotencyKey: idemKey },
    });
    if (existingByKey) {
      if (existingByKey.requestHash !== requestHash) {
        throw new OperationsError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key was already used with a different fulfilment payload."
        );
      }
      const order = await this.prisma.order.findUnique({
        where: { id: existingByKey.orderId },
        select: { id: true, status: true, fulfilledAmount: true },
      });
      return {
        idempotentReplay: true,
        fulfilment: {
          id: existingByKey.id,
          orderId: existingByKey.orderId,
          sourceGameAccountId: existingByKey.sourceGameAccountId,
          deliveredAmount: existingByKey.deliveredAmount.toFixed(0),
          externalReference: existingByKey.externalReference,
          idempotencyKey: existingByKey.idempotencyKey,
          confirmedAt: existingByKey.confirmedAt.toISOString(),
        },
        order: order
          ? {
              id: order.id,
              status: order.status,
              fulfilledAmount: order.fulfilledAmount.toFixed(0),
            }
          : null,
      };
    }

    return this.prisma.$transaction(async (tx) => {
      const lockedOrders = await tx.$queryRaw<
        Array<{
          id: string;
          order_number: string;
          status: OrderStatus;
          game_amount_requested: string;
          fulfilled_amount: string;
          customer_id: string;
          partner_id: string | null;
        }>
      >`
        SELECT id, order_number, status, game_amount_requested::text, fulfilled_amount::text, customer_id, partner_id
        FROM orders
        WHERE id = ${input.orderId}::uuid
        FOR UPDATE
      `;
      const lockedOrder = lockedOrders[0];
      if (!lockedOrder) {
        throw new OperationsError(404, "ORDER_NOT_FOUND", "Order not found.");
      }

      const replayInTx = await tx.manualFulfilmentRecord.findUnique({
        where: { idempotencyKey: idemKey },
      });
      if (replayInTx) {
        if (replayInTx.requestHash !== requestHash) {
          throw new OperationsError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was already used with a different fulfilment payload."
          );
        }
        const order = await tx.order.findUnique({
          where: { id: replayInTx.orderId },
          select: { id: true, status: true, fulfilledAmount: true },
        });
        return {
          idempotentReplay: true,
          fulfilment: {
            id: replayInTx.id,
            orderId: replayInTx.orderId,
            sourceGameAccountId: replayInTx.sourceGameAccountId,
            deliveredAmount: replayInTx.deliveredAmount.toFixed(0),
            externalReference: replayInTx.externalReference,
            idempotencyKey: replayInTx.idempotencyKey,
            confirmedAt: replayInTx.confirmedAt.toISOString(),
          },
          order: order
            ? {
                id: order.id,
                status: order.status,
                fulfilledAmount: order.fulfilledAmount.toFixed(0),
              }
            : null,
        };
      }

      if (
        lockedOrder.status !== OrderStatus.READY_FOR_FULFILMENT &&
        lockedOrder.status !== OrderStatus.PARTIALLY_FULFILLED
      ) {
        throw new OperationsError(
          409,
          "INVALID_ORDER_STATE",
          `Order ${lockedOrder.order_number} is in ${lockedOrder.status} and cannot be manually fulfilled.`
        );
      }

      const requestedAmt = BigInt(lockedOrder.game_amount_requested.split(".")[0] ?? "0");
      const alreadyFulfilled = BigInt(lockedOrder.fulfilled_amount.split(".")[0] ?? "0");
      const remainingUnfulfilled =
        requestedAmt > alreadyFulfilled ? requestedAmt - alreadyFulfilled : 0n;

      if (input.deliveredAmount > remainingUnfulfilled) {
        throw new OperationsError(
          409,
          "EXCEEDS_REMAINING_QUANTITY",
          `Delivered amount (${input.deliveredAmount}) exceeds remaining unfulfilled order quantity (${remainingUnfulfilled}).`
        );
      }

      const duplicateRef = await tx.manualFulfilmentRecord.findUnique({
        where: { externalReference: extRef },
      });
      if (duplicateRef) {
        throw new OperationsError(
          409,
          "DUPLICATE_FULFILMENT_REFERENCE",
          `External fulfilment reference "${extRef}" has already been used.`
        );
      }

      const lockedAccounts = await tx.$queryRaw<
        Array<{
          id: string;
          slot_code: string;
          last_known_balance: string;
          reserved_for_orders: string;
          last_synced_at: Date | null;
        }>
      >`
        SELECT id, slot_code, last_known_balance::text, reserved_for_orders::text, last_synced_at
        FROM game_accounts
        WHERE id = ${input.sourceGameAccountId}::uuid
        FOR UPDATE
      `;
      const lockedAccount = lockedAccounts[0];
      if (!lockedAccount) {
        throw new OperationsError(404, "ACCOUNT_NOT_FOUND", "Source game account not found.");
      }

      const observedBalance = BigInt(lockedAccount.last_known_balance.split(".")[0] ?? "0");
      const totalAccountReserved = BigInt(lockedAccount.reserved_for_orders.split(".")[0] ?? "0");
      const debitsSinceSync = await getManualFulfilmentDebitsSinceSync(
        tx,
        lockedAccount.id,
        lockedAccount.last_synced_at
      );
      const expectedBalance =
        observedBalance > debitsSinceSync ? observedBalance - debitsSinceSync : 0n;

      const orderReservationOnAccount = await tx.inventoryReservation.findUnique({
        where: {
          orderId_gameAccountId: {
            orderId: lockedOrder.id,
            gameAccountId: lockedAccount.id,
          },
        },
      });
      const thisOrderReserved =
        orderReservationOnAccount?.status === InventoryReservationStatus.ACTIVE
          ? BigInt(orderReservationOnAccount.amount.toFixed(0))
          : 0n;
      const otherOrdersReserved =
        totalAccountReserved > thisOrderReserved ? totalAccountReserved - thisOrderReserved : 0n;
      const maxFulfillableFromAccount =
        expectedBalance > otherOrdersReserved ? expectedBalance - otherOrdersReserved : 0n;

      if (input.deliveredAmount > maxFulfillableFromAccount) {
        throw new OperationsError(
          409,
          "INSUFFICIENT_EXPECTED_BALANCE",
          `Delivered amount (${input.deliveredAmount}) exceeds available expected balance (${maxFulfillableFromAccount}) on ${lockedAccount.slot_code}.`
        );
      }

      const record = await tx.manualFulfilmentRecord.create({
        data: {
          orderId: lockedOrder.id,
          sourceGameAccountId: lockedAccount.id,
          deliveredAmount: input.deliveredAmount.toString(),
          externalReference: extRef,
          idempotencyKey: idemKey,
          requestHash,
          notes,
          confirmedByUserId: input.actorUserId,
        },
      });

      const expectedAfterDebit = expectedBalance - input.deliveredAmount;
      await tx.inventoryLedger.create({
        data: {
          gameAccountId: lockedAccount.id,
          orderId: lockedOrder.id,
          entryType: InventoryEntryType.MANUAL_FULFILMENT_DEBIT,
          deltaAmount: (-input.deliveredAmount).toString(),
          balanceAfter: expectedAfterDebit.toString(),
          createdById: input.actorUserId,
          notes: `MANUAL_FULFILMENT_CONFIRMED (ref ${extRef}; lastKnownBalance untouched): ${notes ?? "no notes"}`,
        },
      });

      const newFulfilled = alreadyFulfilled + input.deliveredAmount;
      const isComplete = newFulfilled === requestedAmt;

      let totalConsumedFromAccountReservation = 0n;
      if (
        orderReservationOnAccount &&
        orderReservationOnAccount.status === InventoryReservationStatus.ACTIVE
      ) {
        const resAmt = BigInt(orderReservationOnAccount.amount.toFixed(0));
        const consumeAmt = isComplete ? resAmt : minBigInt(resAmt, input.deliveredAmount);
        totalConsumedFromAccountReservation = consumeAmt;
        const remainingRes = resAmt - consumeAmt;

        if (isComplete || remainingRes === 0n) {
          await tx.inventoryReservation.update({
            where: { id: orderReservationOnAccount.id },
            data: {
              status: InventoryReservationStatus.CONSUMED,
              releasedAt: new Date(),
              releaseReason: "MANUAL_FULFILMENT_CONFIRMED",
            },
          });
        } else {
          await tx.inventoryReservation.update({
            where: { id: orderReservationOnAccount.id },
            data: {
              amount: remainingRes.toString(),
            },
          });
        }

        const nextAccountReserved =
          totalAccountReserved > consumeAmt ? totalAccountReserved - consumeAmt : 0n;
        await tx.gameAccount.update({
          where: { id: lockedAccount.id },
          data: {
            reservedForOrders: nextAccountReserved.toString(),
          },
        });
      }

      if (isComplete) {
        const otherActiveReservations = await tx.inventoryReservation.findMany({
          where: {
            orderId: lockedOrder.id,
            status: InventoryReservationStatus.ACTIVE,
            gameAccountId: { not: lockedAccount.id },
          },
        });
        for (const res of otherActiveReservations) {
          const amt = BigInt(res.amount.toFixed(0));
          await tx.inventoryReservation.update({
            where: { id: res.id },
            data: {
              status: InventoryReservationStatus.RELEASED,
              releasedAt: new Date(),
              releaseReason: "MANUAL_FULFILMENT_COMPLETED",
              amount: "0",
            },
          });
          await tx.gameAccount.update({
            where: { id: res.gameAccountId },
            data: {
              reservedForOrders: { decrement: amt.toString() },
            },
          });
        }
      }

      const nextStatus = isComplete ? OrderStatus.COMPLETED : OrderStatus.PARTIALLY_FULFILLED;
      await tx.order.update({
        where: { id: lockedOrder.id },
        data: {
          fulfilledAmount: newFulfilled.toString(),
          gameAmountDelivered: newFulfilled.toString(),
          status: nextStatus,
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          actionType: "ORDER_MANUAL_FULFILMENT_CONFIRMED",
          targetEntity: "orders",
          targetId: lockedOrder.id,
          beforeState: {
            status: lockedOrder.status,
            fulfilledAmount: alreadyFulfilled.toString(),
            consumedReservation: totalConsumedFromAccountReservation.toString(),
          },
          afterState: {
            status: nextStatus,
            fulfilledAmount: newFulfilled.toString(),
            externalReference: extRef,
            sourceSlotCode: lockedAccount.slot_code,
          },
          reason: notes ?? `Manual fulfilment ref ${extRef}`,
          ipAddress: input.ipAddress,
        },
      });

      const recipientIds: string[] = [];
      const cust = await tx.customer.findUnique({
        where: { id: lockedOrder.customer_id },
        select: { userId: true },
      });
      if (cust?.userId) recipientIds.push(cust.userId);
      if (lockedOrder.partner_id) {
        const partner = await tx.partner.findUnique({
          where: { id: lockedOrder.partner_id },
          select: { userId: true },
        });
        if (partner?.userId) recipientIds.push(partner.userId);
      }
      if (recipientIds.length > 0) {
        await tx.notification.createMany({
          data: Array.from(new Set(recipientIds)).map((recipientUserId) => ({
            recipientUserId,
            type: NotificationType.ORDER_FULFILLED,
            orderId: lockedOrder.id,
            title: isComplete
              ? `Order ${lockedOrder.order_number} fulfilled`
              : `Partial delivery on ${lockedOrder.order_number}`,
            message: `Manual delivery of ${input.deliveredAmount.toString()} confirmed (ref ${extRef}).`,
          })),
        });
      }

      return {
        idempotentReplay: false,
        fulfilment: {
          id: record.id,
          orderId: record.orderId,
          sourceGameAccountId: record.sourceGameAccountId,
          deliveredAmount: record.deliveredAmount.toFixed(0),
          externalReference: record.externalReference,
          idempotencyKey: record.idempotencyKey,
          confirmedAt: record.confirmedAt.toISOString(),
        },
        order: {
          id: lockedOrder.id,
          status: nextStatus,
          fulfilledAmount: newFulfilled.toString(),
        },
      };
    }, { timeout: 20000, maxWait: 10000 });
  }

  async requestRefund(input: {
    orderId: string;
    actorUserId: string;
    scope: RefundScope;
    requestedAmountKobo: bigint;
    reason: string;
    ipAddress?: string;
  }) {
    if (input.requestedAmountKobo <= 0n) {
      throw new OperationsError(400, "INVALID_AMOUNT", "requestedAmountKobo must be positive.");
    }

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: input.orderId },
        select: {
          id: true,
          orderNumber: true,
          verifiedGrossFiatKobo: true,
          confirmedRefundedKobo: true,
        },
      });
      if (!order) {
        throw new OperationsError(404, "ORDER_NOT_FOUND", "Order not found.");
      }

      const remainingVerified =
        order.verifiedGrossFiatKobo > order.confirmedRefundedKobo
          ? order.verifiedGrossFiatKobo - order.confirmedRefundedKobo
          : 0n;
      if (remainingVerified === 0n) {
        throw new OperationsError(
          409,
          "NO_REFUNDABLE_BALANCE",
          "Order has no remaining verified funds available to refund."
        );
      }
      if (input.requestedAmountKobo > remainingVerified) {
        throw new OperationsError(
          409,
          "REFUND_EXCEEDS_VERIFIED_PAYMENT",
          `Requested refund (${input.requestedAmountKobo}) exceeds remaining verified balance (${remainingVerified}).`
        );
      }
      if (input.scope === RefundScope.FULL && input.requestedAmountKobo !== remainingVerified) {
        throw new OperationsError(
          400,
          "INVALID_FULL_REFUND_AMOUNT",
          `FULL refund request must equal remaining verified balance (${remainingVerified}).`
        );
      }

      const request = await tx.refundRequest.create({
        data: {
          orderId: order.id,
          scope: input.scope,
          requestedAmountKobo: input.requestedAmountKobo,
          currentStatus: RefundStatus.REQUESTED,
          createdByUserId: input.actorUserId,
        },
      });

      const event = await tx.refundEvent.create({
        data: {
          refundRequestId: request.id,
          orderId: order.id,
          eventType: RefundStatus.REQUESTED,
          amountKobo: input.requestedAmountKobo,
          reason: input.reason,
          actorUserId: input.actorUserId,
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          actionType: "ORDER_REFUND_REQUESTED",
          targetEntity: "refund_requests",
          targetId: request.id,
          afterState: {
            orderId: order.id,
            scope: input.scope,
            requestedAmountKobo: input.requestedAmountKobo.toString(),
          },
          reason: input.reason,
          ipAddress: input.ipAddress,
        },
      });

      return { request, event };
    }, { timeout: 20000, maxWait: 10000 });
  }

  async advanceRefundToPending(input: {
    orderId: string;
    refundId: string;
    actorUserId: string;
    reason: string;
    ipAddress?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        Array<{ id: string; order_id: string; current_status: RefundStatus; requested_amount_kobo: bigint }>
      >`
        SELECT id, order_id, current_status, requested_amount_kobo
        FROM refund_requests
        WHERE id = ${input.refundId}::uuid AND order_id = ${input.orderId}::uuid
        FOR UPDATE
      `;
      const row = locked[0];
      if (!row) {
        throw new OperationsError(404, "REFUND_NOT_FOUND", "Refund request not found.");
      }
      if (row.current_status !== RefundStatus.REQUESTED) {
        throw new OperationsError(
          409,
          "INVALID_REFUND_STATE",
          `Refund request is ${row.current_status} and cannot move to PENDING.`
        );
      }

      const updated = await tx.refundRequest.update({
        where: { id: row.id },
        data: { currentStatus: RefundStatus.PENDING },
      });

      const event = await tx.refundEvent.create({
        data: {
          refundRequestId: row.id,
          orderId: row.order_id,
          eventType: RefundStatus.PENDING,
          amountKobo: row.requested_amount_kobo,
          reason: input.reason,
          actorUserId: input.actorUserId,
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          actionType: "ORDER_REFUND_MARKED_PENDING",
          targetEntity: "refund_requests",
          targetId: row.id,
          beforeState: { currentStatus: row.current_status },
          afterState: { currentStatus: RefundStatus.PENDING },
          reason: input.reason,
          ipAddress: input.ipAddress,
        },
      });

      return { request: updated, event };
    }, { timeout: 20000, maxWait: 10000 });
  }

  async rejectRefund(input: {
    orderId: string;
    refundId: string;
    actorUserId: string;
    reason: string;
    ipAddress?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        Array<{ id: string; order_id: string; current_status: RefundStatus; requested_amount_kobo: bigint }>
      >`
        SELECT id, order_id, current_status, requested_amount_kobo
        FROM refund_requests
        WHERE id = ${input.refundId}::uuid AND order_id = ${input.orderId}::uuid
        FOR UPDATE
      `;
      const row = locked[0];
      if (!row) {
        throw new OperationsError(404, "REFUND_NOT_FOUND", "Refund request not found.");
      }
      if (
        row.current_status !== RefundStatus.REQUESTED &&
        row.current_status !== RefundStatus.PENDING
      ) {
        throw new OperationsError(
          409,
          "REFUND_ALREADY_FINALIZED",
          `Refund request is already ${row.current_status}.`
        );
      }

      const updated = await tx.refundRequest.update({
        where: { id: row.id },
        data: { currentStatus: RefundStatus.REJECTED },
      });

      const event = await tx.refundEvent.create({
        data: {
          refundRequestId: row.id,
          orderId: row.order_id,
          eventType: RefundStatus.REJECTED,
          amountKobo: row.requested_amount_kobo,
          reason: input.reason,
          actorUserId: input.actorUserId,
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          actionType: "ORDER_REFUND_REJECTED",
          targetEntity: "refund_requests",
          targetId: row.id,
          beforeState: { currentStatus: row.current_status },
          afterState: { currentStatus: RefundStatus.REJECTED },
          reason: input.reason,
          ipAddress: input.ipAddress,
        },
      });

      return { request: updated, event };
    }, { timeout: 20000, maxWait: 10000 });
  }

  async confirmRefund(input: {
    orderId: string;
    refundId: string;
    actorUserId: string;
    confirmedAmountKobo: bigint;
    refundReference: string;
    idempotencyKey: string;
    reason: string;
    ipAddress?: string;
  }) {
    const ref = input.refundReference.trim();
    const idemKey = input.idempotencyKey.trim();
    if (!ref || !idemKey) {
      throw new OperationsError(
        400,
        "INVALID_INPUT",
        "refundReference and idempotencyKey are required."
      );
    }
    if (input.confirmedAmountKobo <= 0n) {
      throw new OperationsError(400, "INVALID_AMOUNT", "confirmedAmountKobo must be positive.");
    }

    const requestHash = hashCanonicalPayload({
      orderId: input.orderId,
      refundId: input.refundId,
      confirmedAmountKobo: input.confirmedAmountKobo.toString(),
      refundReference: ref,
      reason: input.reason.trim(),
    });

    return this.prisma.$transaction(async (tx) => {
      const lockedOrders = await tx.$queryRaw<
        Array<{
          id: string;
          order_number: string;
          status: OrderStatus;
          verified_gross_fiat_kobo: bigint;
          confirmed_refunded_kobo: bigint;
          funding_cycle: number;
          customer_id: string;
          partner_id: string | null;
        }>
      >`
        SELECT id, order_number, status, verified_gross_fiat_kobo, confirmed_refunded_kobo, funding_cycle, customer_id, partner_id
        FROM orders
        WHERE id = ${input.orderId}::uuid
        FOR UPDATE
      `;
      const lockedOrder = lockedOrders[0];
      if (!lockedOrder) {
        throw new OperationsError(404, "ORDER_NOT_FOUND", "Order not found.");
      }

      const lockedRefunds = await tx.$queryRaw<
        Array<{
          id: string;
          order_id: string;
          scope: RefundScope;
          current_status: RefundStatus;
        }>
      >`
        SELECT id, order_id, scope, current_status
        FROM refund_requests
        WHERE id = ${input.refundId}::uuid AND order_id = ${input.orderId}::uuid
        FOR UPDATE
      `;
      const lockedRefund = lockedRefunds[0];
      if (!lockedRefund) {
        throw new OperationsError(404, "REFUND_NOT_FOUND", "Refund request not found.");
      }

      // Check idempotency replay AFTER acquiring row-level locks on order & refund_request,
      // and BEFORE rejecting already-finalized refund state.
      const replayByKey = await tx.refundRequest.findUnique({
        where: { confirmIdempotencyKey: idemKey },
      });
      if (replayByKey) {
        if (replayByKey.confirmRequestHash !== requestHash) {
          throw new OperationsError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was already used with a different refund confirmation payload."
          );
        }
        const order = await tx.order.findUnique({
          where: { id: replayByKey.orderId },
          select: {
            id: true,
            status: true,
            refundFinancialStatus: true,
            confirmedRefundedKobo: true,
          },
        });
        return {
          idempotentReplay: true,
          refundRequest: {
            id: replayByKey.id,
            currentStatus: replayByKey.currentStatus,
            confirmedRefundReference: replayByKey.confirmedRefundReference,
          },
          order: order
            ? {
                id: order.id,
                status: order.status,
                refundFinancialStatus: order.refundFinancialStatus,
                confirmedRefundedKobo: order.confirmedRefundedKobo.toString(),
              }
            : null,
        };
      }

      if (
        lockedRefund.current_status !== RefundStatus.REQUESTED &&
        lockedRefund.current_status !== RefundStatus.PENDING
      ) {
        throw new OperationsError(
          409,
          "REFUND_ALREADY_FINALIZED",
          `Refund request is already ${lockedRefund.current_status}.`
        );
      }

      const duplicateRef = await tx.refundRequest.findUnique({
        where: { confirmedRefundReference: ref },
      });
      if (duplicateRef) {
        throw new OperationsError(
          409,
          "DUPLICATE_REFUND_REFERENCE",
          `Refund reference "${ref}" has already been recorded.`
        );
      }

      const remainingVerifiedBefore =
        lockedOrder.verified_gross_fiat_kobo > lockedOrder.confirmed_refunded_kobo
          ? lockedOrder.verified_gross_fiat_kobo - lockedOrder.confirmed_refunded_kobo
          : 0n;

      if (input.confirmedAmountKobo > remainingVerifiedBefore) {
        throw new OperationsError(
          409,
          "REFUND_EXCEEDS_VERIFIED_PAYMENT",
          `Confirmed refund (${input.confirmedAmountKobo}) exceeds remaining verified balance (${remainingVerifiedBefore}).`
        );
      }

      if (
        lockedRefund.scope === RefundScope.FULL &&
        input.confirmedAmountKobo !== remainingVerifiedBefore
      ) {
        throw new OperationsError(
          400,
          "INVALID_FULL_REFUND_AMOUNT",
          `FULL refund confirmation must equal remaining verified balance (${remainingVerifiedBefore}).`
        );
      }

      const newConfirmedTotal = lockedOrder.confirmed_refunded_kobo + input.confirmedAmountKobo;
      const remainingAfter = lockedOrder.verified_gross_fiat_kobo - newConfirmedTotal;
      const isFullyRefunded = remainingAfter === 0n;

      await tx.refundRequest.update({
        where: { id: lockedRefund.id },
        data: {
          currentStatus: RefundStatus.CONFIRMED,
          confirmIdempotencyKey: idemKey,
          confirmRequestHash: requestHash,
          confirmedRefundReference: ref,
        },
      });

      await tx.refundEvent.create({
        data: {
          refundRequestId: lockedRefund.id,
          orderId: lockedOrder.id,
          eventType: RefundStatus.CONFIRMED,
          amountKobo: input.confirmedAmountKobo,
          refundReference: ref,
          reason: input.reason,
          actorUserId: input.actorUserId,
        },
      });

      const isAlreadyFulfilled =
        lockedOrder.status === OrderStatus.COMPLETED ||
        lockedOrder.status === OrderStatus.PARTIALLY_FULFILLED;

      const nextOrderStatus =
        isFullyRefunded && !isAlreadyFulfilled ? OrderStatus.REFUNDED : lockedOrder.status;

      const nextFinancialStatus = isFullyRefunded
        ? RefundFinancialStatus.FULLY_REFUNDED
        : RefundFinancialStatus.PARTIALLY_REFUNDED;

      await tx.order.update({
        where: { id: lockedOrder.id },
        data: {
          confirmedRefundedKobo: newConfirmedTotal,
          refundFinancialStatus: nextFinancialStatus,
          status: nextOrderStatus,
        },
      });

      // Release unfulfilled reservations only if order becomes fully refunded & was not already fulfilled
      if (isFullyRefunded && !isAlreadyFulfilled) {
        const activeReservations = await tx.inventoryReservation.findMany({
          where: { orderId: lockedOrder.id, status: InventoryReservationStatus.ACTIVE },
        });
        for (const res of activeReservations) {
          const amt = BigInt(res.amount.toFixed(0));
          await tx.inventoryReservation.update({
            where: { id: res.id },
            data: {
              status: InventoryReservationStatus.RELEASED,
              releasedAt: new Date(),
              releaseReason: "FULL_REFUND_CONFIRMED",
              amount: "0",
            },
          });
          await tx.gameAccount.update({
            where: { id: res.gameAccountId },
            data: { reservedForOrders: { decrement: amt.toString() } },
          });
        }
      }

      // Zero-clamped proportional BigInt commission clawback
      const commissionRecord = await tx.commissionRecord.findUnique({
        where: { orderId: lockedOrder.id },
        include: { ledgerEntries: true },
      });
      if (commissionRecord) {
        let partnerNet = 0n;
        let ownerNet = 0n;
        let hasCycleReversal = false;
        for (const e of commissionRecord.ledgerEntries) {
          partnerNet += e.partnerDeltaKobo;
          ownerNet += e.ownerDeltaKobo;
          if (
            e.fundingCycle === lockedOrder.funding_cycle &&
            e.entryType === CommissionLedgerEntryType.REVERSAL
          ) {
            hasCycleReversal = true;
          }
        }

        const partnerRemaining = clampZero(partnerNet);
        const ownerRemaining = clampZero(ownerNet);

        let partnerClawback = 0n;
        let ownerClawback = 0n;
        if (isFullyRefunded) {
          partnerClawback = partnerRemaining;
          ownerClawback = ownerRemaining;
        } else if (remainingVerifiedBefore > 0n) {
          partnerClawback = clampZero(
            minBigInt(
              partnerRemaining,
              (input.confirmedAmountKobo * partnerRemaining) / remainingVerifiedBefore
            )
          );
          ownerClawback = clampZero(
            minBigInt(
              ownerRemaining,
              (input.confirmedAmountKobo * ownerRemaining) / remainingVerifiedBefore
            )
          );
        }

        if (partnerClawback > 0n || ownerClawback > 0n) {
          const entryType =
            isFullyRefunded && !hasCycleReversal
              ? CommissionLedgerEntryType.REVERSAL
              : CommissionLedgerEntryType.PARTIAL_REFUND_ADJUSTMENT;
          await tx.commissionLedgerEntry.create({
            data: {
              commissionRecordId: commissionRecord.id,
              partnerId: commissionRecord.partnerId,
              fundingCycle: lockedOrder.funding_cycle,
              entryType,
              partnerDeltaKobo: -partnerClawback,
              ownerDeltaKobo: -ownerClawback,
              reference: ref,
              idempotencyKey: `refund_confirm:${lockedRefund.id}`,
              notes: `${isFullyRefunded ? "Full" : "Partial"} refund confirmed (${ref}): ${input.reason}`,
              createdById: input.actorUserId,
            },
          });
        }
      }

      await tx.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          actionType: "ORDER_REFUND_CONFIRMED",
          targetEntity: "refund_requests",
          targetId: lockedRefund.id,
          beforeState: {
            orderStatus: lockedOrder.status,
            confirmedRefundedKobo: lockedOrder.confirmed_refunded_kobo.toString(),
          },
          afterState: {
            orderStatus: nextOrderStatus,
            refundFinancialStatus: nextFinancialStatus,
            confirmedRefundedKobo: newConfirmedTotal.toString(),
            refundReference: ref,
          },
          reason: input.reason,
          ipAddress: input.ipAddress,
        },
      });

      const cust = await tx.customer.findUnique({
        where: { id: lockedOrder.customer_id },
        select: { userId: true },
      });
      if (cust?.userId) {
        await tx.notification.create({
          data: {
            recipientUserId: cust.userId,
            type: NotificationType.REFUND_CONFIRMED,
            orderId: lockedOrder.id,
            title: `Refund confirmed for ${lockedOrder.order_number}`,
            message: `Refund of ${(Number(input.confirmedAmountKobo) / 100).toFixed(2)} NGN confirmed (ref ${ref}).`,
          },
        });
      }

      return {
        idempotentReplay: false,
        refundRequest: {
          id: lockedRefund.id,
          currentStatus: RefundStatus.CONFIRMED,
          confirmedRefundReference: ref,
        },
        order: {
          id: lockedOrder.id,
          status: nextOrderStatus,
          refundFinancialStatus: nextFinancialStatus,
          confirmedRefundedKobo: newConfirmedTotal.toString(),
        },
      };
    }, { timeout: 20000, maxWait: 10000 });
  }
}
