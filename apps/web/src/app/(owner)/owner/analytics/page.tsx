"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { formatNaira, formatTrillions } from "@/lib/format";
import { OwnerShell } from "@/components/OwnerShell";
import { Card, StatCard } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/Badge";

interface AnalyticsResponse {
  summary: {
    totalOrders: number;
    completedOrders: number;
    readyForFulfilmentOrders: number;
    completionRatePct: number;
    approvedDecisionsKobo: string;
    reversedDecisionsKobo: string;
    confirmedRefundsKobo: string;
    netVerifiedRevenueKobo: string;
    pendingRefundLiabilityKobo: string;
    outstandingPaymentExposureKobo: string;
    netPartnerCommissionKobo: string;
    netOwnerCommissionKobo: string;
  };
  retention: {
    totalCustomers: number;
    activeBuyers: number;
    repeatBuyers: number;
    repeatPurchaseRatePct: number;
  };
  funnel: Record<string, number>;
  trends: Array<{
    date: string;
    orders: number;
    grossKobo: string;
    netVerifiedKobo: string;
    volume: string;
  }>;
  partnerLeaderboard: Array<{
    partnerId: string;
    displayName: string;
    referralCode: string;
    status: string;
    attributedCustomers: number;
    orders: number;
    completedOrders: number;
    netVerifiedKobo: string;
    netCommissionKobo: string;
  }>;
}

export default function OwnerAnalyticsPage() {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiRequest<AnalyticsResponse>("/owner/analytics");
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load analytics.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const maxTrend = Math.max(
    1,
    ...(data?.trends.map((t) => Number(BigInt(t.netVerifiedKobo) / 100n)) ?? [1])
  );

  return (
    <OwnerShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Business Intelligence</h1>
          <p className="text-sm text-slate-500">
            Reversal-aware financial revenue, refund liabilities, retention, and partner performance.
          </p>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        )}

        {data && (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label="Net Verified Revenue"
                value={formatNaira(data.summary.netVerifiedRevenueKobo)}
                hint={`Approved ${formatNaira(data.summary.approvedDecisionsKobo)} − Reversed/Refunded`}
              />
              <StatCard
                label="Pending Refund Liability"
                value={formatNaira(data.summary.pendingRefundLiabilityKobo)}
                hint={`Confirmed refunds: ${formatNaira(data.summary.confirmedRefundsKobo)}`}
              />
              <StatCard
                label="Outstanding Exposure"
                value={formatNaira(data.summary.outstandingPaymentExposureKobo)}
                hint={`Completion rate: ${data.summary.completionRatePct}%`}
              />
              <StatCard
                label="Repeat Purchase Rate"
                value={`${data.retention.repeatPurchaseRatePct}%`}
                hint={`${data.retention.repeatBuyers} repeat of ${data.retention.activeBuyers} buyers`}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <StatCard
                label="Net Partner Commissions"
                value={formatNaira(data.summary.netPartnerCommissionKobo)}
                hint="Reversal & partial-refund adjusted"
              />
              <StatCard
                label="Net Owner Share"
                value={formatNaira(data.summary.netOwnerCommissionKobo)}
                hint="Reversal & partial-refund adjusted"
              />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <Card title="Daily Net Verified Revenue Trend">
                {data.trends.length === 0 ? (
                  <p className="text-sm text-slate-500">No order history yet.</p>
                ) : (
                  <div className="space-y-2">
                    {data.trends.slice(-14).map((t) => {
                      const naira = Number(BigInt(t.netVerifiedKobo) / 100n);
                      const pct = Math.min(100, Math.max(2, Math.round((naira / maxTrend) * 100)));
                      return (
                        <div key={t.date} className="space-y-1">
                          <div className="flex justify-between text-xs text-slate-600 tabular-nums">
                            <span>{t.date}</span>
                            <span>
                              {formatNaira(t.netVerifiedKobo)} · {t.orders} orders · {formatTrillions(t.volume)}
                            </span>
                          </div>
                          <div className="h-2 w-full rounded-full bg-slate-100">
                            <div
                              className="h-2 rounded-full bg-indigo-600"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>

              <Card title="Order Lifecycle Funnel">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  {Object.entries(data.funnel).map(([status, count]) => (
                    <div
                      key={status}
                      className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2"
                    >
                      <span className="text-xs font-medium text-slate-600">
                        {status.replaceAll("_", " ")}
                      </span>
                      <span className="font-mono font-semibold text-slate-900 tabular-nums">
                        {count}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            </div>

            <Card title="Partner Performance Leaderboard">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                      <th className="py-2 pr-4">Partner</th>
                      <th className="py-2 pr-4">Status</th>
                      <th className="py-2 pr-4">Customers</th>
                      <th className="py-2 pr-4">Orders</th>
                      <th className="py-2 pr-4">Net Verified</th>
                      <th className="py-2">Net Commission</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.partnerLeaderboard.map((p) => (
                      <tr key={p.partnerId}>
                        <td className="py-2.5 pr-4">
                          <p className="font-medium text-slate-900">{p.displayName}</p>
                          <p className="font-mono text-xs text-slate-500">{p.referralCode}</p>
                        </td>
                        <td className="py-2.5 pr-4">
                          <StatusBadge
                            label={p.status}
                            tone={p.status === "ACTIVE" ? "success" : "danger"}
                          />
                        </td>
                        <td className="py-2.5 pr-4 tabular-nums">{p.attributedCustomers}</td>
                        <td className="py-2.5 pr-4 tabular-nums">{p.orders}</td>
                        <td className="py-2.5 pr-4 font-mono tabular-nums">
                          {formatNaira(p.netVerifiedKobo)}
                        </td>
                        <td className="py-2.5 font-mono tabular-nums">
                          {formatNaira(p.netCommissionKobo)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </div>
    </OwnerShell>
  );
}
