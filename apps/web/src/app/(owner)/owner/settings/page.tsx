"use client";

import { useCallback, useEffect, useState } from "react";
import { getRestockingScheduleStatus } from "@bigola/shared";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { formatDateTime } from "@/lib/format";
import { OwnerShell } from "@/components/OwnerShell";
import { Card } from "@/components/ui/Card";
import { Button, CopyButton } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";

interface AuditLogRow {
  id: string;
  actionType: string;
  targetEntity: string;
  targetId: string;
  reason: string | null;
  createdAt: string;
  actor: { email: string; role: string } | null;
}

interface CoOwnerRow {
  id: string;
  email: string;
  mfaEnabled: boolean;
  isActive: boolean;
  createdAt: string;
}

export default function OwnerSettingsPage() {
  const { user } = useAuth();
  const [expiryMinutes, setExpiryMinutes] = useState("30");
  const [freshnessMinutes, setFreshnessMinutes] = useState("15");
  const [maxOrders, setMaxOrders] = useState("2");
  const [policyReason, setPolicyReason] = useState("");
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [coOwners, setCoOwners] = useState<CoOwnerRow[]>([]);
  const [coOwnerEmail, setCoOwnerEmail] = useState("");
  const [coOwnerReason, setCoOwnerReason] = useState("");
  const [invitingCoOwner, setInvitingCoOwner] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [invitedEmail, setInvitedEmail] = useState<string | null>(null);
  const [regeneratingCodes, setRegeneratingCodes] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [marketplaceSalesEnabled, setMarketplaceSalesEnabled] = useState(true);
  const [retailOrdersEnabled, setRetailOrdersEnabled] = useState(true);
  const [bulkOrdersEnabled, setBulkOrdersEnabled] = useState(true);
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  const [customerAvailabilityNote, setCustomerAvailabilityNote] = useState("");
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [whatsappNumberSecondary, setWhatsappNumberSecondary] = useState("");
  const [businessReason, setBusinessReason] = useState("");
  const [savingBusiness, setSavingBusiness] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { pushToast } = useToast();

  const loadSettings = useCallback(async () => {
    try {
      const [invRes, logRes, coOwnerRes, bizRes] = await Promise.all([
        apiRequest<{ maxAgeMinutes: number }>("/owner/inventory"),
        apiRequest<{ logs: AuditLogRow[] }>("/owner/audit-logs"),
        apiRequest<{ owners: CoOwnerRow[] }>("/owner/co-owners"),
        apiRequest<{
          businessSettings: {
            marketplaceSalesEnabled: boolean;
            retailOrdersEnabled: boolean;
            bulkOrdersEnabled: boolean;
            maintenanceMessage: string | null;
            customerAvailabilityNote: string | null;
            whatsappNumber: string | null;
            whatsappNumberSecondary: string | null;
          };
        }>("/owner/business-settings"),
      ]);
      setFreshnessMinutes(String(invRes.maxAgeMinutes));
      setLogs(logRes.logs.slice(0, 25));
      setCoOwners(coOwnerRes.owners);
      setMarketplaceSalesEnabled(bizRes.businessSettings.marketplaceSalesEnabled);
      setRetailOrdersEnabled(bizRes.businessSettings.retailOrdersEnabled);
      setBulkOrdersEnabled(bizRes.businessSettings.bulkOrdersEnabled);
      setMaintenanceMessage(bizRes.businessSettings.maintenanceMessage ?? "");
      setCustomerAvailabilityNote(bizRes.businessSettings.customerAvailabilityNote ?? "");
      setWhatsappNumber(bizRes.businessSettings.whatsappNumber ?? "");
      setWhatsappNumberSecondary(bizRes.businessSettings.whatsappNumberSecondary ?? "");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  async function handleSaveBusinessSettings(e: React.FormEvent) {
    e.preventDefault();
    if (businessReason.trim().length < 3) {
      setError("Enter an audit reason (min 3 chars) before saving business settings.");
      return;
    }
    setSavingBusiness(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest("/owner/business-settings", {
        method: "PUT",
        body: JSON.stringify({
          marketplaceSalesEnabled,
          retailOrdersEnabled,
          bulkOrdersEnabled,
          maintenanceMessage: maintenanceMessage.trim() || null,
          customerAvailabilityNote: customerAvailabilityNote.trim() || null,
          whatsappNumber: whatsappNumber.trim() || null,
          whatsappNumberSecondary: whatsappNumberSecondary.trim() || null,
          reason: businessReason.trim(),
        }),
      });
      setNotice("Business settings updated.");
      pushToast({ title: "Business settings saved", tone: "success" });
      setBusinessReason("");
      await loadSettings();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingBusiness(false);
    }
  }

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
      pushToast({ title: `${label} policy updated`, tone: "success" });
      setPolicyReason("");
      await loadSettings();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleInviteCoOwner(e: React.FormEvent) {
    e.preventDefault();
    if (!coOwnerEmail.trim() || coOwnerReason.trim().length < 3) {
      setError("Enter a valid co-owner email and audit reason (min 3 chars).");
      return;
    }
    setInvitingCoOwner(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiRequest<{ owner: CoOwnerRow; invitePath: string }>("/owner/co-owners", {
        method: "POST",
        body: JSON.stringify({
          email: coOwnerEmail.trim(),
          reason: coOwnerReason.trim(),
        }),
      });
      const fullLink =
        typeof window !== "undefined" ? `${window.location.origin}${res.invitePath}` : res.invitePath;
      setInviteLink(fullLink);
      setInvitedEmail(res.owner.email);
      setCoOwnerEmail("");
      setCoOwnerReason("");
      setNotice(`Co-owner account created for ${res.owner.email}. Share the one-time setup link below.`);
      pushToast({ title: "Co-owner invited", tone: "success" });
      await loadSettings();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInvitingCoOwner(false);
    }
  }

  async function handleRegenerateRecoveryCodes() {
    setRegeneratingCodes(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiRequest<{ recoveryCodes: string[] }>("/auth/2fa/recovery-codes/regenerate", {
        method: "POST",
      });
      setRecoveryCodes(res.recoveryCodes);
      setNotice("Generated 8 new one-time 2FA backup codes. Save them now—previous unused codes are replaced.");
      pushToast({ title: "Backup codes regenerated", tone: "success" });
      await loadSettings();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRegeneratingCodes(false);
    }
  }

  return (
    <OwnerShell>
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-[#0B1324]">
            Settings, Policies &amp; Security
          </h1>
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

        <Card
          title="Business Settings & Customer Availability"
          action={
            <StatusBadge
              label={marketplaceSalesEnabled ? "Marketplace Live" : "Sales Paused"}
              tone={marketplaceSalesEnabled ? "success" : "danger"}
            />
          }
        >
          <form onSubmit={handleSaveBusinessSettings} className="space-y-4">
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">
                  Weekly Restocking Schedule (Africa/Lagos): Closed every Wednesday &amp; Saturday
                </span>
                <StatusBadge
                  label={
                    getRestockingScheduleStatus().isRestockingDay
                      ? `Restocking Day (${getRestockingScheduleStatus().lagosWeekday}) — New Sales Paused`
                      : `Open (${getRestockingScheduleStatus().lagosWeekday} WAT)`
                  }
                  tone={getRestockingScheduleStatus().isRestockingDay ? "warning" : "success"}
                />
              </div>
              <p className="mt-1 text-[11px]">
                New customer orders are automatically rejected on Wednesdays and Saturdays (Africa/Lagos) and reopen automatically on Thursday/Sunday. Existing paid, authorized, or queued orders and running fulfilment jobs are never disrupted.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-medium text-slate-800">
                <span>Marketplace Sales</span>
                <input
                  type="checkbox"
                  checked={marketplaceSalesEnabled}
                  onChange={(e) => setMarketplaceSalesEnabled(e.target.checked)}
                />
              </label>
              <label className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-medium text-slate-800">
                <span>Retail Orders</span>
                <input
                  type="checkbox"
                  checked={retailOrdersEnabled}
                  onChange={(e) => setRetailOrdersEnabled(e.target.checked)}
                />
              </label>
              <label className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-medium text-slate-800">
                <span>Bulk Orders</span>
                <input
                  type="checkbox"
                  checked={bulkOrdersEnabled}
                  onChange={(e) => setBulkOrdersEnabled(e.target.checked)}
                />
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Maintenance Message (shown when sales paused)
                </label>
                <input
                  type="text"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  placeholder="e.g. Scheduled maintenance, back in 30 mins"
                  value={maintenanceMessage}
                  onChange={(e) => setMaintenanceMessage(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Customer Availability Note
                </label>
                <input
                  type="text"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  placeholder="e.g. Instant fulfilment active 8am–11pm WAT"
                  value={customerAvailabilityNote}
                  onChange={(e) => setCustomerAvailabilityNote(e.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Primary WhatsApp Business Number (for payment receipts)
                </label>
                <input
                  type="text"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono-tabular"
                  placeholder="e.g. 2348012345678 or 08012345678"
                  value={whatsappNumber}
                  onChange={(e) => setWhatsappNumber(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Secondary WhatsApp Number (optional)
                </label>
                <input
                  type="text"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono-tabular"
                  placeholder="e.g. 2348098765432 or 08098765432"
                  value={whatsappNumberSecondary}
                  onChange={(e) => setWhatsappNumberSecondary(e.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[220px]">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Audit Reason (min 3 chars)
                </label>
                <input
                  type="text"
                  required
                  minLength={3}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  placeholder="e.g. Toggle storefront sales status"
                  value={businessReason}
                  onChange={(e) => setBusinessReason(e.target.value)}
                />
              </div>
              <Button type="submit" variant="owner" disabled={savingBusiness}>
                {savingBusiness ? "Saving..." : "Save Business Settings"}
              </Button>
            </div>
          </form>
        </Card>

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
              {user?.mfaEnabled && (
                <div className="pt-2 border-t border-slate-100 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-slate-500">
                      Generates 8 fresh one-time backup codes (replaces old ones).
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={regeneratingCodes}
                      onClick={handleRegenerateRecoveryCodes}
                    >
                      {regeneratingCodes ? "Generating..." : "New Backup Codes"}
                    </Button>
                  </div>
                  {recoveryCodes && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-2 text-xs text-amber-900">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">Your 8 New One-Time Backup Codes:</span>
                        <CopyButton value={recoveryCodes.join("\n")} label="Copy All" />
                      </div>
                      <div className="grid grid-cols-2 gap-1.5 font-mono-tabular">
                        {recoveryCodes.map((code) => (
                          <code
                            key={code}
                            className="rounded bg-white px-2 py-1 text-center text-[11px] text-slate-800 border border-amber-200"
                          >
                            {code}
                          </code>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
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

        <Card title="Co-Owner Accounts">
          <div className="space-y-4">
            <p className="text-xs text-slate-600">
              Both owners share full Owner dashboard permissions. Invite your co-owner below to generate a one-time
              24-hour password setup link.
            </p>

            {coOwners.length > 0 && (
              <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-slate-50/50 px-3">
                {coOwners.map((owner) => (
                  <div key={owner.id} className="py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div>
                      <span className="font-medium text-slate-900">{owner.email}</span>
                      <span className="text-slate-400"> • Added {formatDateTime(owner.createdAt)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge
                        label={owner.mfaEnabled ? "2FA Active" : "2FA Pending"}
                        tone={owner.mfaEnabled ? "success" : "warning"}
                      />
                      <StatusBadge
                        label={owner.isActive ? "Active" : "Inactive"}
                        tone={owner.isActive ? "info" : "danger"}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={handleInviteCoOwner} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Co-Owner Email</label>
                <input
                  type="email"
                  required
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  placeholder="co-owner@example.com"
                  value={coOwnerEmail}
                  onChange={(e) => setCoOwnerEmail(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Audit Reason (min 3 chars)</label>
                <input
                  type="text"
                  required
                  minLength={3}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  placeholder="e.g. Add second owner account"
                  value={coOwnerReason}
                  onChange={(e) => setCoOwnerReason(e.target.value)}
                />
              </div>
              <Button type="submit" size="sm" disabled={invitingCoOwner}>
                {invitingCoOwner ? "Inviting..." : "Invite Co-Owner"}
              </Button>
            </form>

            {inviteLink && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 space-y-2">
                <p className="font-semibold">
                  One-time setup link for {invitedEmail} (expires in 24 hours):
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="flex-1 break-all rounded bg-white px-2.5 py-1.5 font-mono-tabular text-[11px] text-slate-800 border border-amber-200">
                    {inviteLink}
                  </code>
                  <CopyButton value={inviteLink} label="Copy Setup Link" />
                </div>
                <p className="text-amber-800">
                  Have your co-owner open this link to set their password, sign in at <code>/login</code>, and enable
                  2FA in Owner Settings.
                </p>
              </div>
            )}
          </div>
        </Card>

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
