import {
  OrderStatus,
  PrismaClient,
  RefundStatus,
  VerificationDecisionType,
} from "@prisma/client";

export class AnalyticsService {
  constructor(private readonly prisma: PrismaClient) {}

  async getOwnerAnalytics(opts?: { from?: Date; to?: Date }) {
    const dateFilter =
      opts?.from || opts?.to
        ? {
            createdAt: {
              ...(opts.from ? { gte: opts.from } : {}),
              ...(opts.to ? { lte: opts.to } : {}),
            },
          }
        : undefined;

    const [
      orders,
      decisions,
      refundRequests,
      commissionEntries,
      partners,
      customers,
    ] = await Promise.all([
      this.prisma.order.findMany({
        where: dateFilter,
        select: {
          id: true,
          customerId: true,
          partnerId: true,
          status: true,
          fiatAmountKobo: true,
          verifiedGrossFiatKobo: true,
          confirmedRefundedKobo: true,
          gameAmountRequested: true,
          fulfilledAmount: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.paymentVerificationDecision.findMany({
        where: dateFilter,
        select: {
          decision: true,
          bankCreditAmountKobo: true,
        },
      }),
      this.prisma.refundRequest.findMany({
        where: dateFilter,
        select: {
          currentStatus: true,
          requestedAmountKobo: true,
        },
      }),
      this.prisma.commissionLedgerEntry.findMany({
        where: dateFilter,
        select: {
          partnerId: true,
          partnerDeltaKobo: true,
          ownerDeltaKobo: true,
        },
      }),
      this.prisma.partner.findMany({
        select: {
          id: true,
          displayName: true,
          referralCode: true,
          status: true,
          _count: { select: { attributedCustomers: true } },
        },
      }),
      this.prisma.customer.findMany({
        select: { id: true, category: true },
      }),
    ]);

    let approvedDecisionsKobo = 0n;
    let reversedDecisionsKobo = 0n;
    for (const d of decisions) {
      const amt = d.bankCreditAmountKobo ?? 0n;
      if (d.decision === VerificationDecisionType.APPROVED) {
        approvedDecisionsKobo += amt;
      } else if (d.decision === VerificationDecisionType.REVERSED) {
        reversedDecisionsKobo += amt;
      }
    }

    let confirmedRefundsKobo = 0n;
    let outstandingExposureKobo = 0n;
    const statusCounts: Record<string, number> = {};
    const customerOrderCounts = new Map<string, number>();
    const partnerOrderStats = new Map<
      string,
      { orders: number; completedOrders: number; netVerifiedKobo: bigint }
    >();
    const trendBuckets = new Map<
      string,
      { date: string; orders: number; grossKobo: bigint; netVerifiedKobo: bigint; volume: bigint }
    >();

    for (const o of orders) {
      statusCounts[o.status] = (statusCounts[o.status] ?? 0) + 1;
      customerOrderCounts.set(o.customerId, (customerOrderCounts.get(o.customerId) ?? 0) + 1);
      confirmedRefundsKobo += o.confirmedRefundedKobo;

      if (
        o.status === OrderStatus.AWAITING_PAYMENT ||
        o.status === OrderStatus.PAYMENT_SUBMITTED ||
        o.status === OrderStatus.PROOF_SUBMITTED ||
        o.status === OrderStatus.PAYMENT_EXCEPTION_REVIEW
      ) {
        const unpaid =
          o.fiatAmountKobo > o.verifiedGrossFiatKobo
            ? o.fiatAmountKobo - o.verifiedGrossFiatKobo
            : 0n;
        outstandingExposureKobo += unpaid;
      }

      const orderNetVerified =
        o.verifiedGrossFiatKobo > o.confirmedRefundedKobo
          ? o.verifiedGrossFiatKobo - o.confirmedRefundedKobo
          : 0n;

      if (o.partnerId) {
        const cur = partnerOrderStats.get(o.partnerId) ?? {
          orders: 0,
          completedOrders: 0,
          netVerifiedKobo: 0n,
        };
        cur.orders += 1;
        if (
          o.status === OrderStatus.READY_FOR_FULFILMENT ||
          o.status === OrderStatus.COMPLETED
        ) {
          cur.completedOrders += 1;
        }
        cur.netVerifiedKobo += orderNetVerified;
        partnerOrderStats.set(o.partnerId, cur);
      }

      const dayKey = o.createdAt.toISOString().slice(0, 10);
      const bucket = trendBuckets.get(dayKey) ?? {
        date: dayKey,
        orders: 0,
        grossKobo: 0n,
        netVerifiedKobo: 0n,
        volume: 0n,
      };
      bucket.orders += 1;
      bucket.grossKobo += o.fiatAmountKobo;
      bucket.netVerifiedKobo += orderNetVerified;
      bucket.volume += BigInt(o.gameAmountRequested.toFixed(0));
      trendBuckets.set(dayKey, bucket);
    }

    let pendingRefundLiabilityKobo = 0n;
    for (const rr of refundRequests) {
      if (
        rr.currentStatus === RefundStatus.REQUESTED ||
        rr.currentStatus === RefundStatus.PENDING
      ) {
        pendingRefundLiabilityKobo += rr.requestedAmountKobo;
      }
    }

    let netPartnerCommissionKobo = 0n;
    let netOwnerCommissionKobo = 0n;
    const partnerCommissionMap = new Map<string, bigint>();
    for (const ce of commissionEntries) {
      netPartnerCommissionKobo += ce.partnerDeltaKobo;
      netOwnerCommissionKobo += ce.ownerDeltaKobo;
      if (ce.partnerId) {
        partnerCommissionMap.set(
          ce.partnerId,
          (partnerCommissionMap.get(ce.partnerId) ?? 0n) + ce.partnerDeltaKobo
        );
      }
    }

    const netVerifiedRevenueKobo =
      approvedDecisionsKobo - reversedDecisionsKobo - confirmedRefundsKobo;

    const activeBuyers = customerOrderCounts.size;
    let repeatBuyers = 0;
    for (const count of customerOrderCounts.values()) {
      if (count >= 2) repeatBuyers += 1;
    }

    const readyOrCompleted =
      (statusCounts[OrderStatus.READY_FOR_FULFILMENT] ?? 0) +
      (statusCounts[OrderStatus.PARTIALLY_FULFILLED] ?? 0) +
      (statusCounts[OrderStatus.COMPLETED] ?? 0);

    return {
      summary: {
        totalOrders: orders.length,
        completedOrders: statusCounts[OrderStatus.COMPLETED] ?? 0,
        readyForFulfilmentOrders: statusCounts[OrderStatus.READY_FOR_FULFILMENT] ?? 0,
        completionRatePct:
          orders.length > 0 ? Math.round((readyOrCompleted / orders.length) * 1000) / 10 : 0,
        approvedDecisionsKobo: approvedDecisionsKobo.toString(),
        reversedDecisionsKobo: reversedDecisionsKobo.toString(),
        confirmedRefundsKobo: confirmedRefundsKobo.toString(),
        netVerifiedRevenueKobo: netVerifiedRevenueKobo.toString(),
        pendingRefundLiabilityKobo: pendingRefundLiabilityKobo.toString(),
        outstandingPaymentExposureKobo: outstandingExposureKobo.toString(),
        netPartnerCommissionKobo: netPartnerCommissionKobo.toString(),
        netOwnerCommissionKobo: netOwnerCommissionKobo.toString(),
      },
      retention: {
        totalCustomers: customers.length,
        activeBuyers,
        repeatBuyers,
        repeatPurchaseRatePct:
          activeBuyers > 0 ? Math.round((repeatBuyers / activeBuyers) * 1000) / 10 : 0,
      },
      funnel: statusCounts,
      trends: Array.from(trendBuckets.values()).map((t) => ({
        date: t.date,
        orders: t.orders,
        grossKobo: t.grossKobo.toString(),
        netVerifiedKobo: t.netVerifiedKobo.toString(),
        volume: t.volume.toString(),
      })),
      partnerLeaderboard: partners
        .map((p) => {
          const stats = partnerOrderStats.get(p.id) ?? {
            orders: 0,
            completedOrders: 0,
            netVerifiedKobo: 0n,
          };
          return {
            partnerId: p.id,
            displayName: p.displayName,
            referralCode: p.referralCode,
            status: p.status,
            attributedCustomers: p._count.attributedCustomers,
            orders: stats.orders,
            completedOrders: stats.completedOrders,
            netVerifiedKobo: stats.netVerifiedKobo.toString(),
            netCommissionKobo: (partnerCommissionMap.get(p.id) ?? 0n).toString(),
          };
        })
        .sort((a, b) => Number(BigInt(b.netVerifiedKobo) - BigInt(a.netVerifiedKobo))),
    };
  }

  async getPartnerPerformance(partnerId: string, windowDays: number = 30) {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const [customers, orders, ledger] = await Promise.all([
      this.prisma.customer.findMany({
        where: { attributedPartnerId: partnerId },
        select: { id: true, createdAt: true },
      }),
      this.prisma.order.findMany({
        where: { partnerId },
        select: {
          id: true,
          customerId: true,
          status: true,
          fiatAmountKobo: true,
          verifiedGrossFiatKobo: true,
          confirmedRefundedKobo: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.commissionLedgerEntry.findMany({
        where: { partnerId },
        select: {
          entryType: true,
          partnerDeltaKobo: true,
          createdAt: true,
        },
      }),
    ]);

    const newCustomersInWindow = customers.filter((c) => c.createdAt >= since).length;
    const buyingCustomers = new Set(
      orders
        .filter(
          (o) =>
            o.status === OrderStatus.READY_FOR_FULFILMENT ||
            o.status === OrderStatus.PARTIALLY_FULFILLED ||
            o.status === OrderStatus.COMPLETED
        )
        .map((o) => o.customerId)
    );

    let netVerifiedVolumeKobo = 0n;
    let windowOrders = 0;
    for (const o of orders) {
      if (o.createdAt >= since) windowOrders += 1;
      const net =
        o.verifiedGrossFiatKobo > o.confirmedRefundedKobo
          ? o.verifiedGrossFiatKobo - o.confirmedRefundedKobo
          : 0n;
      netVerifiedVolumeKobo += net;
    }

    let netCommissionKobo = 0n;
    let reversedCommissionKobo = 0n;
    for (const l of ledger) {
      netCommissionKobo += l.partnerDeltaKobo;
      if (l.partnerDeltaKobo < 0n) {
        reversedCommissionKobo += -l.partnerDeltaKobo;
      }
    }

    return {
      windowDays,
      totalAttributedCustomers: customers.length,
      newCustomersInWindow,
      convertedCustomers: buyingCustomers.size,
      conversionRatePct:
        customers.length > 0
          ? Math.round((buyingCustomers.size / customers.length) * 1000) / 10
          : 0,
      totalOrders: orders.length,
      windowOrders,
      netVerifiedVolumeKobo: netVerifiedVolumeKobo.toString(),
      netCommissionKobo: netCommissionKobo.toString(),
      reversedCommissionKobo: reversedCommissionKobo.toString(),
    };
  }

  async getPartnerActivity(partnerId: string, userId: string) {
    const [logs, recentOrders] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { actorUserId: userId },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: {
          id: true,
          actionType: true,
          targetEntity: true,
          targetId: true,
          reason: true,
          createdAt: true,
        },
      }),
      this.prisma.order.findMany({
        where: { partnerId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          fiatAmountKobo: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      auditEvents: logs.map((l) => ({
        ...l,
        createdAt: l.createdAt.toISOString(),
      })),
      recentOrders: recentOrders.map((o) => ({
        ...o,
        fiatAmountKobo: o.fiatAmountKobo.toString(),
        createdAt: o.createdAt.toISOString(),
      })),
    };
  }
}
