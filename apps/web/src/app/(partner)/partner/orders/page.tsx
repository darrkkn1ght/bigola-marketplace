"use client";

import { useCallback, useEffect, useState } from "react";
import { ONE_TRILLION } from "@bigola/shared";
import { apiRequest } from "@/lib/api";
import { formatDateTime, formatNaira, formatTrillions } from "@/lib/format";
import { PartnerShell } from "@/components/PartnerShell";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { OrderStatusBadge } from "@/components/ui/Badge";
import { SlideOver } from "@/components/ui/SlideOver";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";

interface PartnerCustomerOption {
  id: string;
  fullName: string;
  lagoslifeUsername: string | null;
}

interface PartnerOrderRow {
  id: string;
  orderNumber: string;
  paymentReference: string;
  channel: string;
  gameAmountRequested: string;
  fiatAmountKobo: string;
  verifiedGrossFiatKobo: string;
  recipientLagoslifeUsername: string;
  status: string;
  createdAt: string;
  customer?: { fullName: string };
}

export default function PartnerOrdersPage() {
  const [orders, setOrders] = useState<PartnerOrderRow[]>([]);
  const [customers, setCustomers] = useState<PartnerCustomerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [trillions, setTrillions] = useState(10);
  const [recipient, setRecipient] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { pushToast } = useToast();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [ordRes, custRes] = await Promise.all([
        apiRequest<{ orders: PartnerOrderRow[] }>("/partner/orders"),
        apiRequest<{ customers: PartnerCustomerOption[] }>("/partner/customers"),
      ]);
      setOrders(ordRes.orders);
      setCustomers(custRes.customers);
      setCustomerId((prev) => prev || custRes.customers[0]?.id || "");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function handleCreateOfflineOrder(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const idempotencyKey =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `p-ord-${Date.now()}`;
      const res = await apiRequest<{ order: { orderNumber: string; paymentReference: string } }>(
        "/partner/orders",
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({
            customerId,
            orderType: "BULK",
            gameAmount: (BigInt(trillions) * ONE_TRILLION).toString(),
            recipientLagoslifeUsername: recipient.trim(),
          }),
        }
      );
      setNotice(
        `Offline order ${res.order.orderNumber} reserved (Ref: ${res.order.paymentReference}).`
      );
      pushToast({ title: "Offline order reserved", description: res.order.orderNumber, tone: "success" });
      setDrawerOpen(false);
      setRecipient("");
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PartnerShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-[#0B1324]">
              Partner Orders
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Create central offline orders for your attributed customers and track status.
            </p>
          </div>
          <Button variant="partner" onClick={() => setDrawerOpen(true)}>
            Create Offline Order
          </Button>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {notice}
          </div>
        )}

        <Card>
          {loading ? (
            <div className="space-y-3">
              <SkeletonCard />
              <SkeletonCard />
            </div>
          ) : orders.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 p-8 text-center">
              <p className="font-display text-sm font-semibold text-[#0B1324]">
                No partner orders found
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Create an offline order or share your referral link to start tracking sales.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {orders.map((ord) => (
                <div
                  key={ord.id}
                  className="py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-sm"
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono-tabular font-semibold text-slate-900">
                        {ord.orderNumber}
                      </span>
                      <OrderStatusBadge status={ord.status} />
                    </div>
                    <p className="mt-0.5 text-xs text-slate-600">
                      {ord.customer?.fullName ?? "Customer"} • {formatTrillions(ord.gameAmountRequested)} • Recipient:{" "}
                      {ord.recipientLagoslifeUsername}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      Ref: <span className="font-mono-tabular">{ord.paymentReference}</span> • {formatDateTime(ord.createdAt)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono-tabular font-semibold text-slate-900">
                      {formatNaira(ord.fiatAmountKobo)}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Verified: {formatNaira(ord.verifiedGrossFiatKobo)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <SlideOver
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Create Central Offline Order"
        subtitle="Reserves stock in the central ledger at ₦1,000 per 1T (min 10T)."
      >
        <form onSubmit={handleCreateOfflineOrder} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Attributed Customer</label>
            <select
              required
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm"
              value={customerId}
              onChange={(e) => {
                setCustomerId(e.target.value);
                const selected = customers.find((c) => c.id === e.target.value);
                if (selected?.lagoslifeUsername) setRecipient(selected.lagoslifeUsername);
              }}
            >
              <option value="">Select customer</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.fullName} ({c.lagoslifeUsername ?? "No username"})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Quantity in Trillions (min 10T)
            </label>
            <input
              type="number"
              min={10}
              step={1}
              required
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 font-mono-tabular text-sm"
              value={trillions}
              onChange={(e) => setTrillions(Number(e.target.value))}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Recipient LagosLife Username
            </label>
            <input
              type="text"
              required
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            />
          </div>
          <Button type="submit" variant="partner" disabled={submitting} className="w-full">
            {submitting ? "Reserving…" : "Create Offline Order & Reserve"}
          </Button>
        </form>
      </SlideOver>
    </PartnerShell>
  );
}
