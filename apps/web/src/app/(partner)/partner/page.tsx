"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiRequest } from "@/lib/api";
import { formatDateTime, formatNaira } from "@/lib/format";
import { PartnerShell } from "@/components/PartnerShell";
import { Card, StatCard } from "@/components/ui/Card";
import { Button, CopyButton } from "@/components/ui/Button";
import { OrderStatusBadge, StatusBadge } from "@/components/ui/Badge";
import { SkeletonCard } from "@/components/ui/Skeleton";

interface PartnerDashboardData {
  partner: {
    id: string;
    displayName: string;
    referralCode: string;
    referralUrl: string;
    status: string;
  };
  metrics: {
    attributedCustomers: number;
    totalOrders: number;
    grossReferredSalesKobo: string;
    accruedKobo: string;
    approvedForPayoutKobo: string;
    paidKobo: string;
    categoryBStatus: string;
  };
}

interface PartnerOrder {
  id: string;
  orderNumber: string;
  fiatAmountKobo: string;
  verifiedGrossFiatKobo: string;
  status: string;
  createdAt: string;
  customer?: { fullName: string };
}

interface PartnerAnalyticsData {
  windowDays: number;
  newCustomersInWindow: number;
  conversionRatePct: number;
  netVerifiedVolumeKobo: string;
  netCommissionKobo: string;
  reversedCommissionKobo: string;
}

export default function PartnerOverviewPage() {
  const [dashboard, setDashboard] = useState<PartnerDashboardData | null>(null);
  const [analytics, setAnalytics] = useState<PartnerAnalyticsData | null>(null);
  const [recentOrders, setRecentOrders] = useState<PartnerOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiRequest<PartnerDashboardData>("/partner/dashboard"),
      apiRequest<{ orders: PartnerOrder[] }>("/partner/orders"),
      apiRequest<{ analytics: PartnerAnalyticsData }>("/partner/analytics?days=30"),
    ])
      .then(([dash, ord, ana]) => {
        setDashboard(dash);
        setRecentOrders(ord.orders.slice(0, 6));
        setAnalytics(ana.analytics);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <PartnerShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-[#0B1324]">
              {dashboard?.partner.displayName ?? "Partner Workspace"}
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Track your attributed customers, verified sales, and 50/50 Category A commissions.
            </p>
          </div>
          {dashboard && (
            <StatusBadge
              label={`Status: ${dashboard.partner.status}`}
              tone={dashboard.partner.status === "ACTIVE" ? "success" : "warning"}
            />
          )}
        </div>

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        )}

        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : (
          dashboard && (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard
                  label="Verified Sales"
                  value={formatNaira(dashboard.metrics.grossReferredSalesKobo)}
                  accentColor="text-[#0284C7]"
                />
                <StatCard
                  label="Pending Commission"
                  value={formatNaira(dashboard.metrics.accruedKobo)}
                  hint="50% of verified Category A gross"
                />
                <StatCard
                  label="Approved / Paid"
                  value={formatNaira(
                    (
                      BigInt(dashboard.metrics.approvedForPayoutKobo) +
                      BigInt(dashboard.metrics.paidKobo)
                    ).toString()
                  )}
                  accentColor="text-[#059669]"
                />
                <StatCard
                  label="Attributed Customers"
                  value={String(dashboard.metrics.attributedCustomers)}
                  hint={`${dashboard.metrics.totalOrders} total order(s)`}
                />
              </div>

              <Card
                title="Your Referral Link"
                subtitle="Share this link with buyers. First valid attribution is permanently linked to your Partner account."
              >
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-200 bg-sky-50/60 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-xs text-slate-500">
                      Code: <span className="font-mono-tabular font-semibold text-slate-900">{dashboard.partner.referralCode}</span>
                    </p>
                    <p className="truncate font-mono-tabular text-sm text-slate-800">
                      {dashboard.partner.referralUrl}
                    </p>
                  </div>
                  <CopyButton value={dashboard.partner.referralUrl} label="Copy Referral Link" />
                </div>
              </Card>

              {analytics && (
                <Card title="30-Day Acquisition & Performance">
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 text-sm">
                    <div className="rounded-lg bg-slate-50 p-3">
                      <p className="text-xs text-slate-500">New Customers (30d)</p>
                      <p className="mt-1 font-mono-tabular text-lg font-bold text-slate-900">
                        {analytics.newCustomersInWindow}
                      </p>
                    </div>
                    <div className="rounded-lg bg-slate-50 p-3">
                      <p className="text-xs text-slate-500">Buyer Conversion Rate</p>
                      <p className="mt-1 font-mono-tabular text-lg font-bold text-slate-900">
                        {analytics.conversionRatePct}%
                      </p>
                    </div>
                    <div className="rounded-lg bg-slate-50 p-3">
                      <p className="text-xs text-slate-500">Net Verified Volume</p>
                      <p className="mt-1 font-mono-tabular text-lg font-bold text-slate-900">
                        {formatNaira(analytics.netVerifiedVolumeKobo)}
                      </p>
                    </div>
                    <div className="rounded-lg bg-slate-50 p-3">
                      <p className="text-xs text-slate-500">Reversed / Adjusted</p>
                      <p className="mt-1 font-mono-tabular text-lg font-bold text-rose-600">
                        {formatNaira(analytics.reversedCommissionKobo)}
                      </p>
                    </div>
                  </div>
                </Card>
              )}

              <Card
                title="Recent Attributed Orders"
                action={
                  <Link href="/partner/orders">
                    <Button variant="secondary" size="sm">
                      View All Orders
                    </Button>
                  </Link>
                }
              >
                {recentOrders.length === 0 ? (
                  <p className="text-sm text-slate-500">No attributed orders yet.</p>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {recentOrders.map((ord) => (
                      <div key={ord.id} className="py-3 flex flex-wrap items-center justify-between gap-2 text-sm">
                        <div>
                          <p className="font-mono-tabular font-semibold text-slate-900">{ord.orderNumber}</p>
                          <p className="text-xs text-slate-500">
                            {ord.customer?.fullName ?? "Customer"} • {formatDateTime(ord.createdAt)}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-mono-tabular font-semibold text-slate-900">
                            {formatNaira(ord.fiatAmountKobo)}
                          </span>
                          <OrderStatusBadge status={ord.status} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </>
          )
        )}
      </div>
    </PartnerShell>
  );
}
