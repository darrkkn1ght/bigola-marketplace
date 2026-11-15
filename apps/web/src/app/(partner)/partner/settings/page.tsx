"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { PartnerShell } from "@/components/PartnerShell";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/Badge";

interface PartnerBankAccount {
  id: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  isDefault: boolean;
  isActive: boolean;
}

interface PartnerBankChangeRequest {
  id: string;
  actionType: string;
  status: string;
  requestReason?: string;
  confirmationReason?: string | null;
  reason?: string;
  decisionReason?: string | null;
  proposedData: {
    bankName?: string;
    accountNumber?: string;
    accountName?: string;
  };
}

export default function PartnerSettingsPage() {
  const { user } = useAuth();
  const [canVerifyPayments, setCanVerifyPayments] = useState(false);
  const [accounts, setAccounts] = useState<PartnerBankAccount[]>([]);
  const [requests, setRequests] = useState<PartnerBankChangeRequest[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const res = await apiRequest<{
        canVerifyPayments: boolean;
        accounts: PartnerBankAccount[];
        requests: PartnerBankChangeRequest[];
      }>("/partner/bank-account-requests");
      setCanVerifyPayments(res.canVerifyPayments);
      setAccounts(res.accounts);
      setRequests(res.requests);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function handleDecision(requestId: string, approve: boolean) {
    const reason = (reasons[requestId] ?? "").trim();
    if (reason.length < 3) {
      setError("A mandatory reason (at least 3 characters) is required to confirm or reject.");
      return;
    }
    setError(null);
    setNotice(null);
    try {
      await apiRequest(`/partner/bank-account-requests/${requestId}/confirm`, {
        method: "POST",
        body: JSON.stringify({ approve, reason }),
      });
      setNotice(
        approve
          ? "OPay receiving account change confirmed and applied."
          : "OPay receiving account change rejected."
      );
      setReasons((prev) => ({ ...prev, [requestId]: "" }));
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <PartnerShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Settings & OPay Dual-Control</h1>
          <p className="mt-1 text-sm text-slate-600">
            Review your account permissions and confirm or reject Owner proposals affecting your OPay receiving account.
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

        <Card title="Partner Profile & Permissions">
          <div className="flex flex-wrap items-center justify-between gap-4 text-sm">
            <div>
              <p className="font-semibold text-slate-900">{user?.partnerDisplayName ?? user?.email}</p>
              <p className="text-xs text-slate-500">{user?.email}</p>
            </div>
            <StatusBadge
              label={canVerifyPayments ? "Payment Verifier: Authorized" : "Payment Verifier: Not Authorized"}
              tone={canVerifyPayments ? "success" : "neutral"}
            />
          </div>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Your OPay Receiving Accounts">
            {accounts.length === 0 ? (
              <p className="text-sm text-slate-500">No receiving bank accounts linked yet.</p>
            ) : (
              <div className="space-y-3">
                {accounts.map((acc) => (
                  <div key={acc.id} className="rounded-lg border border-slate-200 p-3.5 text-sm">
                    <p className="font-semibold text-slate-900">
                      {acc.bankName} • <span className="font-mono-tabular">{acc.accountNumber}</span>
                    </p>
                    <p className="text-xs text-slate-600">{acc.accountName}</p>
                    <div className="mt-2 flex gap-2">
                      {acc.isDefault && <StatusBadge label="Default" tone="info" />}
                      <StatusBadge label={acc.isActive ? "Active" : "Inactive"} tone={acc.isActive ? "success" : "neutral"} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card
            title="Dual-Control Change Requests"
            subtitle="Owner proposals cannot take effect until you explicitly confirm them."
          >
            {requests.length === 0 ? (
              <p className="text-sm text-slate-500">No change requests yet.</p>
            ) : (
              <div className="space-y-4">
                {requests.map((req) => (
                  <div key={req.id} className="rounded-lg border border-slate-200 p-4 text-xs space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-900">{req.actionType}</span>
                      <StatusBadge
                        label={req.status.replaceAll("_", " ")}
                        tone={
                          req.status === "APPROVED"
                            ? "success"
                            : req.status === "REJECTED"
                              ? "danger"
                              : "warning"
                        }
                      />
                    </div>
                    <p className="text-slate-700">
                      Proposed: {req.proposedData.bankName ?? "—"} • {req.proposedData.accountNumber ?? "—"} (
                      {req.proposedData.accountName ?? "—"})
                    </p>
                    <p className="text-slate-500">
                      Proposal Reason: {req.requestReason ?? req.reason ?? "—"}
                    </p>
                    {(req.confirmationReason ?? req.decisionReason) && (
                      <p className="text-slate-500">
                        Decision Reason: {req.confirmationReason ?? req.decisionReason}
                      </p>
                    )}

                    {req.status === "PENDING_PARTNER_CONFIRMATION" && (
                      <div className="pt-2 space-y-2 border-t border-slate-100">
                        <input
                          type="text"
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                          placeholder="Mandatory confirmation or rejection reason (min 3 chars)"
                          value={reasons[req.id] ?? ""}
                          onChange={(e) =>
                            setReasons((prev) => ({ ...prev, [req.id]: e.target.value }))
                          }
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" onClick={() => handleDecision(req.id, true)}>
                            Confirm & Apply
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => handleDecision(req.id, false)}>
                            Reject Request
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </PartnerShell>
  );
}
