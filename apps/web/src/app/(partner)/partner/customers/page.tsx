"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { formatDateTime, formatNaira, formatTrillions } from "@/lib/format";
import { PartnerShell } from "@/components/PartnerShell";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { OrderStatusBadge, StatusBadge } from "@/components/ui/Badge";
import { SlideOver } from "@/components/ui/SlideOver";

interface PartnerCustomer {
  id: string;
  fullName: string;
  lagoslifeUsername: string | null;
  category: string;
  attributionSource: string;
  attributedAt: string | null;
  _count: { orders: number };
}

interface CustomerOrderRow {
  id: string;
  orderNumber: string;
  gameAmountRequested: string;
  fiatAmountKobo: string;
  verifiedGrossFiatKobo: string;
  status: string;
  createdAt: string;
}

export default function PartnerCustomersPage() {
  const [customers, setCustomers] = useState<PartnerCustomer[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Register offline customer drawer
  const [registerOpen, setRegisterOpen] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [lagoslifeUsername, setLagoslifeUsername] = useState("");
  const [saving, setSaving] = useState(false);

  // Purchase history drawer
  const [historyCustomer, setHistoryCustomer] = useState<PartnerCustomer | null>(null);
  const [customerOrders, setCustomerOrders] = useState<CustomerOrderRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const loadCustomers = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const qs = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
      const res = await apiRequest<{ customers: PartnerCustomer[] }>(`/partner/customers${qs}`);
      setCustomers(res.customers);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCustomers("");
  }, [loadCustomers]);

  async function handleRegisterOffline(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest("/partner/customers/offline", {
        method: "POST",
        body: JSON.stringify({
          fullName: fullName.trim(),
          email: email.trim() || undefined,
          phone: phone.trim() || undefined,
          lagoslifeUsername: lagoslifeUsername.trim() || undefined,
        }),
      });
      setNotice(`Registered ${fullName.trim()} under your permanent attribution.`);
      setRegisterOpen(false);
      setFullName("");
      setEmail("");
      setPhone("");
      setLagoslifeUsername("");
      await loadCustomers(search);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function openHistory(customer: PartnerCustomer) {
    setHistoryCustomer(customer);
    setHistoryLoading(true);
    try {
      const res = await apiRequest<{ orders: CustomerOrderRow[] }>(
        `/partner/customers/${customer.id}/orders`
      );
      setCustomerOrders(res.orders);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setHistoryLoading(false);
    }
  }

  return (
    <PartnerShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">My Customers</h1>
            <p className="mt-1 text-sm text-slate-600">
              Search attributed customers, register offline buyers, and inspect purchase history.
            </p>
          </div>
          <Button variant="partner" onClick={() => setRegisterOpen(true)}>
            Register Offline Customer
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
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void loadCustomers(search);
            }}
            className="mb-4 flex flex-wrap gap-2"
          >
            <input
              type="text"
              className="flex-1 min-w-[220px] rounded-lg border border-slate-300 px-3.5 py-2 text-sm text-slate-900 focus:border-[#0284C7] focus:outline-none"
              placeholder="Search by customer name or LagosLife username…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Button type="submit" variant="secondary" size="md">
              Search
            </Button>
          </form>

          {loading ? (
            <p className="text-sm text-slate-500">Loading customers…</p>
          ) : customers.length === 0 ? (
            <p className="text-sm text-slate-500">No attributed customers match your filter.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {customers.map((c) => (
                <div
                  key={c.id}
                  className="py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-slate-900">{c.fullName}</p>
                      <StatusBadge label={c.attributionSource.replaceAll("_", " ")} tone="info" />
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      LagosLife: {c.lagoslifeUsername ?? "—"} • Orders: {c._count.orders} • Attributed{" "}
                      {formatDateTime(c.attributedAt)}
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => void openHistory(c)}>
                    Purchase History
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <SlideOver
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        title="Register Offline Customer"
        subtitle="Creates a permanently attributed Category A customer under your Partner account."
      >
        <form onSubmit={handleRegisterOffline} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Full Name</label>
            <input
              type="text"
              required
              minLength={2}
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Email (optional)</label>
            <input
              type="email"
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Phone (optional)</label>
            <input
              type="tel"
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              LagosLife Username (optional)
            </label>
            <input
              type="text"
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm"
              value={lagoslifeUsername}
              onChange={(e) => setLagoslifeUsername(e.target.value)}
            />
          </div>
          <Button type="submit" variant="partner" disabled={saving} className="w-full">
            {saving ? "Registering…" : "Register Offline Attribution"}
          </Button>
        </form>
      </SlideOver>

      <SlideOver
        open={Boolean(historyCustomer)}
        onClose={() => setHistoryCustomer(null)}
        title={historyCustomer ? `${historyCustomer.fullName} — Orders` : ""}
        subtitle={
          historyCustomer?.lagoslifeUsername
            ? `LagosLife: ${historyCustomer.lagoslifeUsername}`
            : undefined
        }
      >
        {historyLoading ? (
          <p className="text-sm text-slate-500">Loading purchase history…</p>
        ) : customerOrders.length === 0 ? (
          <p className="text-sm text-slate-500">No orders placed by this customer yet.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {customerOrders.map((ord) => (
              <div key={ord.id} className="py-3 space-y-1 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-mono-tabular font-semibold text-slate-900">
                    {ord.orderNumber}
                  </span>
                  <OrderStatusBadge status={ord.status} />
                </div>
                <p className="text-slate-600">
                  {formatTrillions(ord.gameAmountRequested)} • Total {formatNaira(ord.fiatAmountKobo)} • Verified{" "}
                  {formatNaira(ord.verifiedGrossFiatKobo)}
                </p>
                <p className="text-slate-400">{formatDateTime(ord.createdAt)}</p>
              </div>
            ))}
          </div>
        )}
      </SlideOver>
    </PartnerShell>
  );
}
