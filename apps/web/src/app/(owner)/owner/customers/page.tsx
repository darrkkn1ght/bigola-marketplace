"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { formatDateTime, formatNaira } from "@/lib/format";
import { OwnerShell } from "@/components/OwnerShell";
import { Card } from "@/components/ui/Card";
import { Button, CopyButton } from "@/components/ui/Button";
import { OrderStatusBadge, StatusBadge } from "@/components/ui/Badge";

interface OwnerCustomerRow {
  id: string;
  userId: string | null;
  fullName: string;
  email: string | null;
  lagoslifeUsername: string | null;
  category: string;
  attributedPartner: { displayName: string; referralCode: string } | null;
  orderCount: number;
  recentOrders: Array<{
    id: string;
    orderNumber: string;
    status: string;
    fiatAmountKobo: string;
    createdAt: string;
  }>;
}

export default function OwnerCustomersPage() {
  const [customers, setCustomers] = useState<OwnerCustomerRow[]>([]);
  const [partners, setPartners] = useState<Array<{ id: string; displayName: string; referralCode: string }>>([]);
  const [selectedPartnerByCustomer, setSelectedPartnerByCustomer] = useState<Record<string, string>>({});
  const [assigningCustomerId, setAssigningCustomerId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [resetInfo, setResetInfo] = useState<{ email: string; url: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadCustomers = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const qs = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
      const [res, pRes] = await Promise.all([
        apiRequest<{ customers: OwnerCustomerRow[] }>(`/owner/customers${qs}`),
        apiRequest<{ partners: Array<{ id: string; displayName: string; referralCode: string }> }>("/owner/partners").catch(() => ({ partners: [] })),
      ]);
      setCustomers(res.customers);
      setPartners(pRes.partners || []);
      const initMap: Record<string, string> = {};
      for (const c of res.customers) {
        const match = (pRes.partners || []).find(
          (p) => c.attributedPartner && p.referralCode === c.attributedPartner.referralCode
        );
        initMap[c.id] = match?.id ?? "";
      }
      setSelectedPartnerByCustomer(initMap);
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

  async function handleIssueReset(userId: string, email: string) {
    setError(null);
    try {
      const res = await apiRequest<{ resetToken: string }>(`/owner/users/${userId}/issue-reset-token`, {
        method: "POST",
        body: JSON.stringify({ reason: "Owner-issued customer password reset" }),
      });
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      setResetInfo({
        email,
        url: `${origin}/reset-password?token=${encodeURIComponent(res.resetToken)}`,
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleAssignPartner(customerId: string, fullName: string) {
    setAssigningCustomerId(customerId);
    setError(null);
    setNotice(null);
    try {
      const targetPartnerId = selectedPartnerByCustomer[customerId] || null;
      await apiRequest(`/owner/customers/${customerId}/attribution`, {
        method: "POST",
        body: JSON.stringify({
          targetPartnerId,
          reason: targetPartnerId
            ? "Owner assigned existing customer to Partner from Customer Directory"
            : "Owner set customer to Direct (Category B) from Customer Directory",
        }),
      });
      setNotice(`Updated Partner attribution for ${fullName}.`);
      await loadCustomers(search);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAssigningCustomerId(null);
    }
  }

  return (
    <OwnerShell>
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-[#0B1324]">
            Customer Directory
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Search all marketplace buyers, inspect attribution category, and issue password reset links when requested.
          </p>
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

        {resetInfo && (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-xs text-indigo-950 space-y-2">
            <div className="flex items-center justify-between">
              <p className="font-semibold">One-time password reset link for {resetInfo.email}</p>
              <button
                type="button"
                onClick={() => setResetInfo(null)}
                className="text-indigo-700 hover:underline cursor-pointer"
              >
                Dismiss
              </button>
            </div>
            <div className="flex items-center gap-2 rounded-lg bg-white border border-indigo-200 p-2.5">
              <code className="font-mono-tabular flex-1 break-all">{resetInfo.url}</code>
              <CopyButton value={resetInfo.url} label="Copy Reset Link" />
            </div>
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
              className="flex-1 min-w-[220px] rounded-lg border border-slate-300 px-3.5 py-2 text-sm"
              placeholder="Search by name, email, or LagosLife username…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Button type="submit" variant="secondary">
              Search
            </Button>
          </form>

          {loading ? (
            <p className="text-sm text-slate-500">Loading customers…</p>
          ) : customers.length === 0 ? (
            <p className="text-sm text-slate-500">No customers found.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {customers.map((c) => (
                <div key={c.id} className="py-4 first:pt-0 last:pb-0 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-slate-900">{c.fullName}</span>
                        <StatusBadge
                          label={c.category === "CATEGORY_A_PARTNER" ? "Category A (Partner)" : "Category B (Direct)"}
                          tone={c.category === "CATEGORY_A_PARTNER" ? "info" : "neutral"}
                        />
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {c.email ?? "Offline customer"} • LagosLife: {c.lagoslifeUsername ?? "—"} • Partner:{" "}
                        {c.attributedPartner ? `${c.attributedPartner.displayName} (${c.attributedPartner.referralCode})` : "Direct"} •{" "}
                        {c.orderCount} order(s)
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800"
                        value={selectedPartnerByCustomer[c.id] ?? ""}
                        onChange={(e) =>
                          setSelectedPartnerByCustomer((prev) => ({
                            ...prev,
                            [c.id]: e.target.value,
                          }))
                        }
                      >
                        <option value="">Direct (Big Ola — No Partner)</option>
                        {partners.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.displayName} ({p.referralCode})
                          </option>
                        ))}
                      </select>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={assigningCustomerId === c.id}
                        onClick={() => void handleAssignPartner(c.id, c.fullName)}
                      >
                        {assigningCustomerId === c.id ? "Saving…" : "Assign Partner"}
                      </Button>
                      {c.userId && c.email && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleIssueReset(c.userId!, c.email!)}
                        >
                          Issue Reset Token
                        </Button>
                      )}
                    </div>
                  </div>

                  {c.recentOrders.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {c.recentOrders.map((o) => (
                        <div
                          key={o.id}
                          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px]"
                        >
                          <span className="font-mono-tabular font-semibold">{o.orderNumber}</span>
                          <span className="font-mono-tabular">{formatNaira(o.fiatAmountKobo)}</span>
                          <OrderStatusBadge status={o.status} />
                          <span className="text-slate-400">{formatDateTime(o.createdAt)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </OwnerShell>
  );
}
