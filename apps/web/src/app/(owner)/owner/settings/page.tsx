"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { formatDateTime } from "@/lib/format";
import { OwnerShell } from "@/components/OwnerShell";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/Badge";

interface AuditLogRow {
  id: string;
  actionType: string;
  targetEntity: string;
  targetId: string;
  reason: string | null;
  createdAt: string;
  actor: { email: string; role: string } | null;
}

export default function OwnerSettingsPage() {
  const { user } = useAuth();
  const [expiryMinutes, setExpiryMinutes] = useState("30");
  const [freshnessMinutes, setFreshnessMinutes] = useState("15");
  const [maxOrders, setMaxOrders] = useState("2");
  const [policyReason, setPolicyReason] = useState("");
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      const [invRes, logRes] = await Promise.all([
        apiRequest<{ maxAgeMinutes: number }>("/owner/inventory"),
        apiRequest<{ logs: AuditLogRow[] }>("/owner/audit-logs"),
      ]);
      setFreshnessMinutes(String(invRes.maxAgeMinutes));
      setLogs(logRes.logs.slice(0, 25));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  async function savePolicy(endpoint: string, payload: Record<string, unknown>, label: string) {
    if (policyReason.trim().length < 3) {
      setError("Enter an audit reason (min 3 chars) before updating policies.");
      return;
    }
    setError(null);
    setNotice(null);
    try {
      await apiRequest(endpoint, {
        method: "PUT",
        body: JSON.stringify({ ...payload, reason: policyReason.trim() }),
      });
      setNotice(`${label} policy updated.`);
      setPolicyReason("");
      await loadSettings();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <OwnerShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Settings, Policies & Security</h1>
          <p className="mt-1 text-sm text-slate-600">
            Configure reservation expiry, inventory freshness, hoarding limits, and inspect the immutable audit log.
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

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Security & Safeguards">
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-600">Owner 2FA Protection</span>
                <StatusBadge
                  label={user?.mfaEnabled ? "Enabled & Active" : "Not Enabled"}
                  tone={user?.mfaEnabled ? "success" : "danger"}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600">Automatic Game Transfers</span>
                <StatusBadge label="DISABLED (Manual Fulfilment Only)" tone="info" />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600">Signed-In Owner</span>
                <span className="font-medium text-slate-900">{user?.email}</span>
              </div>
            </div>
          </Card>

          <Card title="Operational Policies">
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Audit Reason for Policy Changes (min 3 chars)
                </label>
                <input
                  type="text"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  placeholder="e.g. Standard marketplace policy tuning"
                  value={policyReason}
                  onChange={(e) => setPolicyReason(e.target.value)}
                />
              </div>

              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-xs text-slate-600 mb-1">Unpaid Expiry (minutes)</label>
                  <input
                    type="number"
                    min={1}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 font-mono-tabular text-xs"
                    value={expiryMinutes}
                    onChange={(e) => setExpiryMinutes(e.target.value)}
                  />
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    savePolicy(
                      "/owner/settings/order-expiry",
                      { unpaidExpiryMinutes: Number(expiryMinutes) },
                      "Order expiry"
                    )
                  }
                >
                  Save Expiry
                </Button>
              </div>

              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-xs text-slate-600 mb-1">Inventory Freshness (minutes)</label>
                  <input
                    type="number"
                    min={1}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 font-mono-tabular text-xs"
                    value={freshnessMinutes}
                    onChange={(e) => setFreshnessMinutes(e.target.value)}
                  />
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    savePolicy(
                      "/owner/settings/inventory-freshness",
                      { maxAgeMinutes: Number(freshnessMinutes) },
                      "Inventory freshness"
                    )
                  }
                >
                  Save Freshness
                </Button>
              </div>

              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-xs text-slate-600 mb-1">
                    Max Active Unpaid Orders / Customer
                  </label>
                  <input
                    type="number"
                    min={1}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 font-mono-tabular text-xs"
                    value={maxOrders}
                    onChange={(e) => setMaxOrders(e.target.value)}
                  />
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    savePolicy(
                      "/owner/settings/hoarding",
                      {
                        maxActiveUnpaidOrdersPerCustomer: Number(maxOrders),
                        maxReservedGameAmountPerCustomer: "100000000000000",
                      },
                      "Anti-hoarding"
                    )
                  }
                >
                  Save Limit
                </Button>
              </div>
            </div>
          </Card>
        </div>

        <Card title="Recent Audit Log">
          {logs.length === 0 ? (
            <p className="text-sm text-slate-500">No audit entries recorded yet.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {logs.map((log) => (
                <div key={log.id} className="py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div>
                    <span className="font-mono-tabular font-semibold text-slate-900">{log.actionType}</span>
                    <span className="text-slate-500">
                      {" "}
                      • {log.targetEntity} • {log.actor?.email ?? "System"}
                    </span>
                    {log.reason && <p className="text-slate-500">Reason: {log.reason}</p>}
                  </div>
                  <span className="text-slate-400">{formatDateTime(log.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </OwnerShell>
  );
}
