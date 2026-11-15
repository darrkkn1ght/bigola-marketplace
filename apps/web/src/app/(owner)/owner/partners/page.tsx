"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { OwnerShell } from "@/components/OwnerShell";
import { Card } from "@/components/ui/Card";
import { Button, CopyButton } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/Badge";
import { SlideOver } from "@/components/ui/SlideOver";

interface PartnerRow {
  id: string;
  userId: string;
  displayName: string;
  referralCode: string;
  status: string;
  canVerifyPayments: boolean;
  user?: { email: string; isActive: boolean };
  _count?: { attributedCustomers: number; orders: number };
}

interface BankAccountRow {
  id: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  isDefault: boolean;
  isActive: boolean;
  ownerPartner?: { id: string; displayName: string };
}

interface BankChangeRequestRow {
  id: string;
  actionType: string;
  status: string;
  reason: string;
  ownerPartner?: { displayName: string };
}

interface ConflictRow {
  id: string;
  matchedField: string;
  matchedValueMasked: string;
  status: string;
  existingPartner?: { displayName: string } | null;
  requestedPartner: { displayName: string; referralCode: string };
}

export default function OwnerPartnersPage() {
  const [partners, setPartners] = useState<PartnerRow[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccountRow[]>([]);
  const [changeRequests, setChangeRequests] = useState<BankChangeRequestRow[]>([]);
  const [conflicts, setConflicts] = useState<ConflictRow[]>([]);
  const [verifierReasons, setVerifierReasons] = useState<Record<string, string>>({});
  const [issuedTokenInfo, setIssuedTokenInfo] = useState<{ label: string; token: string; url?: string } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Invite Partner Drawer
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invName, setInvName] = useState("");
  const [invEmail, setInvEmail] = useState("");
  const [invPhone, setInvPhone] = useState("");
  const [invRefCode, setInvRefCode] = useState("");

  // Propose OPay Change Drawer
  const [opayOpen, setOpayOpen] = useState(false);
  const [bankActionType, setBankActionType] = useState<"CREATE" | "UPDATE" | "DEACTIVATE">("CREATE");
  const [bankOwnerPartnerId, setBankOwnerPartnerId] = useState("");
  const [targetBankAccountId, setTargetBankAccountId] = useState("");
  const [bankName, setBankName] = useState("OPay");
  const [accountNumber, setAccountNumber] = useState("");
  const [accountName, setAccountName] = useState("");
  const [isDefaultBank, setIsDefaultBank] = useState(true);
  const [bankReason, setBankReason] = useState("");

  const loadData = useCallback(async () => {
    try {
      const [pRes, bRes, cRes] = await Promise.all([
        apiRequest<{ partners: PartnerRow[] }>("/owner/partners"),
        apiRequest<{ accounts: BankAccountRow[]; changeRequests: BankChangeRequestRow[] }>(
          "/owner/bank-accounts"
        ),
        apiRequest<{ conflicts: ConflictRow[] }>("/owner/attribution-conflicts"),
      ]);
      setPartners(pRes.partners);
      setBankAccounts(bRes.accounts);
      setChangeRequests(bRes.changeRequests);
      setConflicts(cRes.conflicts);
      setBankOwnerPartnerId((prev) => prev || pRes.partners[0]?.id || "");
      setTargetBankAccountId((prev) => prev || bRes.accounts[0]?.id || "");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function handleInvitePartner(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await apiRequest<{
        partner: { displayName: string };
        inviteToken?: string;
      }>("/owner/partners", {
        method: "POST",
        body: JSON.stringify({
          displayName: invName.trim(),
          email: invEmail.trim(),
          phone: invPhone.trim() || undefined,
          requestedReferralCode: invRefCode.trim() || undefined,
        }),
      });
      setInviteOpen(false);
      setInvName("");
      setInvEmail("");
      setInvPhone("");
      setInvRefCode("");
      if (res.inviteToken) {
        const origin = typeof window !== "undefined" ? window.location.origin : "";
        setIssuedTokenInfo({
          label: `One-time Partner setup link for ${res.partner.displayName}`,
          token: res.inviteToken,
          url: `${origin}/reset-password?token=${encodeURIComponent(res.inviteToken)}`,
        });
      }
      setNotice(`Partner ${res.partner.displayName} provisioned.`);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleToggleVerifier(partner: PartnerRow) {
    const reason = (verifierReasons[partner.id] ?? "").trim();
    if (reason.length < 3) {
      setError("A mandatory reason (at least 3 characters) is required to grant or revoke verifier access.");
      return;
    }
    setError(null);
    setNotice(null);
    try {
      await apiRequest(`/owner/partners/${partner.id}/verification-permission`, {
        method: "PUT",
        body: JSON.stringify({
          canVerifyPayments: !partner.canVerifyPayments,
          reason,
        }),
      });
      setVerifierReasons((prev) => ({ ...prev, [partner.id]: "" }));
      setNotice(
        `${!partner.canVerifyPayments ? "Granted" : "Revoked"} verifier permission for ${partner.displayName}.`
      );
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleIssueReset(userId: string, label: string) {
    setError(null);
    try {
      const res = await apiRequest<{ resetToken: string }>(`/owner/users/${userId}/issue-reset-token`, {
        method: "POST",
        body: JSON.stringify({ reason: "Owner-issued password reset via Partners console" }),
      });
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      setIssuedTokenInfo({
        label: `One-time password reset for ${label}`,
        token: res.resetToken,
        url: `${origin}/reset-password?token=${encodeURIComponent(res.resetToken)}`,
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleProposeBankChange(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await apiRequest("/owner/bank-accounts/propose", {
        method: "POST",
        body: JSON.stringify({
          ownerPartnerId: bankOwnerPartnerId,
          actionType: bankActionType,
          receivingBankAccountId: bankActionType === "CREATE" ? undefined : targetBankAccountId,
          proposedData:
            bankActionType === "DEACTIVATE"
              ? { isActive: false, isDefault: false }
              : {
                  bankName: bankName.trim() || undefined,
                  accountNumber: accountNumber.trim() || undefined,
                  accountName: accountName.trim() || undefined,
                  isDefault: isDefaultBank,
                  isActive: true,
                },
          reason: bankReason.trim(),
        }),
      });
      setNotice("OPay proposal submitted. Account-holding Partner must confirm before it takes effect.");
      setOpayOpen(false);
      setBankReason("");
      setAccountNumber("");
      setAccountName("");
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleResolveConflict(conflictId: string, decision: "KEEP_EXISTING" | "DISMISS") {
    setError(null);
    try {
      await apiRequest(`/owner/attribution-conflicts/${conflictId}/resolve`, {
        method: "POST",
        body: JSON.stringify({
          decision,
          reason: `Resolved by Owner (${decision})`,
        }),
      });
      setNotice("Attribution conflict resolved.");
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <OwnerShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Partners & OPay Governance</h1>
            <p className="mt-1 text-sm text-slate-600">
              Provision Partner accounts, manage verifier permissions, propose OPay changes, and resolve attribution conflicts.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => setOpayOpen(true)}>
              Propose OPay Change
            </Button>
            <Button variant="owner" size="sm" onClick={() => setInviteOpen(true)}>
              Invite Partner
            </Button>
          </div>
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

        {issuedTokenInfo && (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-xs text-indigo-950 space-y-2">
            <div className="flex items-center justify-between">
              <p className="font-semibold">{issuedTokenInfo.label}</p>
              <button
                type="button"
                onClick={() => setIssuedTokenInfo(null)}
                className="text-indigo-700 hover:underline cursor-pointer"
              >
                Dismiss
              </button>
            </div>
            <p>Share this one-time link securely. It is shown only once and never logged.</p>
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-white border border-indigo-200 p-2.5">
              <code className="font-mono-tabular flex-1 break-all">
                {issuedTokenInfo.url ?? issuedTokenInfo.token}
              </code>
              <CopyButton value={issuedTokenInfo.url ?? issuedTokenInfo.token} label="Copy Setup Link" />
            </div>
          </div>
        )}

        <Card title="Partners & Payment Verifier Access">
          {partners.length === 0 ? (
            <p className="text-sm text-slate-500">No partners provisioned yet.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {partners.map((p) => (
                <div key={p.id} className="py-4 first:pt-0 last:pb-0 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-slate-900">{p.displayName}</span>
                        <StatusBadge label={p.status} tone={p.status === "ACTIVE" ? "success" : "warning"} />
                        <StatusBadge
                          label={p.canVerifyPayments ? "Verifier: Authorized" : "Verifier: Off"}
                          tone={p.canVerifyPayments ? "info" : "neutral"}
                        />
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {p.user?.email} • Code: <span className="font-mono-tabular">{p.referralCode}</span> •{" "}
                        {p._count?.attributedCustomers ?? 0} customers • {p._count?.orders ?? 0} orders
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleIssueReset(p.userId, p.displayName)}
                    >
                      Issue Reset Token
                    </Button>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      className="flex-1 min-w-[220px] rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                      placeholder="Mandatory audit reason (min 3 chars)"
                      value={verifierReasons[p.id] ?? ""}
                      onChange={(e) =>
                        setVerifierReasons((prev) => ({ ...prev, [p.id]: e.target.value }))
                      }
                    />
                    <Button
                      size="sm"
                      variant={p.canVerifyPayments ? "danger" : "primary"}
                      onClick={() => handleToggleVerifier(p)}
                    >
                      {p.canVerifyPayments ? "Revoke Verifier" : "Grant Verifier"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="OPay Receiving Accounts">
            {bankAccounts.length === 0 ? (
              <p className="text-sm text-slate-500">No receiving accounts configured yet.</p>
            ) : (
              <div className="space-y-3">
                {bankAccounts.map((acc) => (
                  <div key={acc.id} className="rounded-lg border border-slate-200 p-3 text-xs">
                    <p className="font-semibold text-slate-900">
                      {acc.bankName} • <span className="font-mono-tabular">{acc.accountNumber}</span> ({acc.accountName})
                    </p>
                    <p className="text-slate-500">
                      Owner Partner: {acc.ownerPartner?.displayName ?? "—"} • {acc.isDefault ? "DEFAULT • " : ""}
                      {acc.isActive ? "ACTIVE" : "INACTIVE"}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {changeRequests.length > 0 && (
              <div className="mt-4 border-t border-slate-100 pt-4 space-y-2">
                <p className="text-xs font-semibold text-slate-700">Recent Dual-Control Proposals</p>
                {changeRequests.slice(0, 5).map((r) => (
                  <div key={r.id} className="flex items-center justify-between text-xs text-slate-600">
                    <span>
                      {r.actionType} ({r.ownerPartner?.displayName ?? "—"})
                    </span>
                    <StatusBadge
                      label={r.status.replaceAll("_", " ")}
                      tone={r.status === "APPROVED" ? "success" : r.status === "REJECTED" ? "danger" : "warning"}
                    />
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Attribution Conflict Queue">
            {conflicts.length === 0 ? (
              <p className="text-sm text-slate-500">No attribution conflicts recorded.</p>
            ) : (
              <div className="space-y-3">
                {conflicts.map((c) => (
                  <div key={c.id} className="rounded-lg border border-slate-200 p-3 text-xs space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-900">
                        {c.matchedField}: {c.matchedValueMasked}
                      </span>
                      <StatusBadge label={c.status} tone={c.status === "PENDING" ? "warning" : "neutral"} />
                    </div>
                    <p className="text-slate-600">
                      Existing: {c.existingPartner?.displayName ?? "Direct"} → Requested: {c.requestedPartner.displayName}
                    </p>
                    {c.status === "PENDING" && (
                      <div className="flex gap-2">
                        <Button size="sm" variant="secondary" onClick={() => handleResolveConflict(c.id, "KEEP_EXISTING")}>
                          Keep Existing
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => handleResolveConflict(c.id, "DISMISS")}>
                          Dismiss
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <SlideOver
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invite & Provision Partner"
        subtitle="Creates an ACTIVE Partner account with a one-time password setup link (no hardcoded password)."
      >
        <form onSubmit={handleInvitePartner} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Display Name</label>
            <input
              type="text"
              required
              minLength={2}
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm"
              value={invName}
              onChange={(e) => setInvName(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Email</label>
            <input
              type="email"
              required
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm"
              value={invEmail}
              onChange={(e) => setInvEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Phone (optional)</label>
            <input
              type="tel"
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm"
              value={invPhone}
              onChange={(e) => setInvPhone(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Preferred Referral Code (optional)
            </label>
            <input
              type="text"
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2 font-mono-tabular text-sm"
              placeholder="Auto-generated if blank"
              value={invRefCode}
              onChange={(e) => setInvRefCode(e.target.value)}
            />
          </div>
          <Button type="submit" variant="owner" className="w-full">
            Create Partner & Generate Setup Link
          </Button>
        </form>
      </SlideOver>

      <SlideOver
        open={opayOpen}
        onClose={() => setOpayOpen(false)}
        title="Propose OPay Receiving Account Change"
        subtitle="Requires confirmation from the account-holding Partner."
      >
        <form onSubmit={handleProposeBankChange} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Action</label>
            <select
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              value={bankActionType}
              onChange={(e) => setBankActionType(e.target.value as "CREATE" | "UPDATE" | "DEACTIVATE")}
            >
              <option value="CREATE">CREATE</option>
              <option value="UPDATE">UPDATE</option>
              <option value="DEACTIVATE">DEACTIVATE</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Account-Holding Partner</label>
            <select
              required
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              value={bankOwnerPartnerId}
              onChange={(e) => setBankOwnerPartnerId(e.target.value)}
            >
              <option value="">Select Partner</option>
              {partners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName} ({p.referralCode})
                </option>
              ))}
            </select>
          </div>
          {bankActionType !== "CREATE" && (
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Target Account</label>
              <select
                required
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                value={targetBankAccountId}
                onChange={(e) => setTargetBankAccountId(e.target.value)}
              >
                <option value="">Select Account</option>
                {bankAccounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.bankName} • {acc.accountNumber} ({acc.accountName})
                  </option>
                ))}
              </select>
            </div>
          )}
          {bankActionType !== "DEACTIVATE" && (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Bank Name</label>
                <input
                  type="text"
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm"
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Account Number</label>
                <input
                  type="text"
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2 font-mono-tabular text-sm"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Account Name</label>
                <input
                  type="text"
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm"
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={isDefaultBank}
                  onChange={(e) => setIsDefaultBank(e.target.checked)}
                />
                Set as Default Receiving Account
              </label>
            </>
          )}
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Mandatory Reason (min 5 chars)
            </label>
            <input
              type="text"
              required
              minLength={5}
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm"
              value={bankReason}
              onChange={(e) => setBankReason(e.target.value)}
            />
          </div>
          <Button type="submit" variant="owner" className="w-full">
            Submit Proposal for Partner Confirmation
          </Button>
        </form>
      </SlideOver>
    </OwnerShell>
  );
}
