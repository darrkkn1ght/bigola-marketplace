"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { formatDateTime, formatNaira } from "@/lib/format";
import { Card, StatCard } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { OrderStatusBadge, StatusBadge } from "@/components/ui/Badge";
import { SlideOver } from "@/components/ui/SlideOver";

interface ReceivingAccount {
  id: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  isDefault: boolean;
  isActive: boolean;
}

interface StatementLine {
  id: string;
  receivingBankAccountId: string;
  transactionReference: string;
  amountKobo: string;
  creditedAt: string;
  senderName: string | null;
  reconciliationStatus?: string;
  status?: string;
}

interface QueueOrder {
  id: string;
  orderNumber: string;
  paymentReference: string;
  status: string;
  paymentExceptionType: string;
  fiatAmountKobo: string;
  verifiedGrossFiatKobo: string;
  fundingCycle: number;
  customer: { id: string; fullName: string; category: string };
  partner: { id: string; displayName: string; referralCode: string } | null;
  lastActedBy: { email: string; role: string; decision: string; actedAt: string } | null;
  proofs: Array<{
    id: string;
    bankReference: string;
    senderAccountName: string;
    claimedAmountKobo: string;
    verificationStatus: string;
  }>;
  decisions: Array<{
    id: string;
    decision: string;
    bankCreditAmountKobo: string | null;
    bankCreditReference: string | null;
    supersedesDecisionId: string | null;
    createdAt: string;
  }>;
}

interface AccountabilityReport {
  paymentsVerified: {
    statementLinkedCount: number;
    manualWithoutStatementCount: number;
    approvedGrossKobo: string;
    reversedGrossKobo: string;
    netVerifiedCustomerPaymentsKobo: string;
  };
  outstandingBalancesKobo: string;
  commissionEntitlements: {
    totalNetPartnerEntitlementKobo: string;
    totalNetOwnerEntitlementKobo: string;
  };
}

interface LocalParsedLine {
  id: string;
  transactionReference: string;
  amountKobo: string;
  creditedAt: string;
  senderName?: string;
  narration?: string;
  keep: boolean;
}

function parseStatementLocally(rawText: string, format: "CSV" | "JSON"): LocalParsedLine[] {
  if (format === "JSON") {
    const parsed = JSON.parse(rawText);
    const arr = Array.isArray(parsed) ? parsed : parsed.lines ?? parsed.transactions ?? [];
    return arr.map((row: Record<string, unknown>, i: number) => ({
      id: `${i}-${String(row.transactionReference ?? row.reference ?? "")}`,
      transactionReference: String(row.transactionReference ?? row.reference ?? ""),
      amountKobo: String(
        row.amountKobo ?? Math.round(Number(row.amountNaira ?? row.amount ?? 0) * 100)
      ),
      creditedAt: String(row.creditedAt ?? row.timestamp ?? new Date().toISOString()),
      senderName: row.senderName ? String(row.senderName) : undefined,
      narration: row.narration ? String(row.narration) : undefined,
      keep: true,
    }));
  }

  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const refIdx = headers.findIndex((h) => h.includes("ref"));
  const amtKoboIdx = headers.findIndex((h) => h.includes("kobo"));
  const amtIdx = amtKoboIdx >= 0 ? amtKoboIdx : headers.findIndex((h) => h.includes("amount"));
  const dateIdx = headers.findIndex((h) => h.includes("date") || h.includes("time"));
  const senderIdx = headers.findIndex((h) => h.includes("sender"));
  const narrIdx = headers.findIndex((h) => h.includes("narr") || h.includes("desc"));

  return lines.slice(1).map((line, i) => {
    const cols = line.split(",").map((c) => c.trim());
    const rawAmt = Number(cols[amtIdx] ?? 0);
    const amountKobo = amtKoboIdx >= 0 ? String(Math.round(rawAmt)) : String(Math.round(rawAmt * 100));
    return {
      id: `${i}-${cols[refIdx] ?? i}`,
      transactionReference: cols[refIdx] ?? "",
      amountKobo,
      creditedAt: cols[dateIdx] ? new Date(cols[dateIdx]).toISOString() : new Date().toISOString(),
      senderName: senderIdx >= 0 ? cols[senderIdx] : undefined,
      narration: narrIdx >= 0 ? cols[narrIdx] : undefined,
      keep: true,
    };
  });
}

export function VerificationDeskPanel({ isOwner }: { isOwner: boolean }) {
  const [queue, setQueue] = useState<QueueOrder[]>([]);
  const [accounts, setAccounts] = useState<ReceivingAccount[]>([]);
  const [statementLines, setStatementLines] = useState<StatementLine[]>([]);
  const [accountability, setAccountability] = useState<AccountabilityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Local statement pre-filter state
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [statementFormat, setStatementFormat] = useState<"CSV" | "JSON">("CSV");
  const [fileName, setFileName] = useState("opay-statement.csv");
  const [localLines, setLocalLines] = useState<LocalParsedLine[]>([]);
  const [uploading, setUploading] = useState(false);

  // Selected order drawer state
  const [selectedOrder, setSelectedOrder] = useState<QueueOrder | null>(null);
  const [selectedLineIds, setSelectedLineIds] = useState<string[]>([]);
  const [manualMode, setManualMode] = useState(false);
  const [manualRef, setManualRef] = useState("");
  const [manualAmountNaira, setManualAmountNaira] = useState("");
  const [decisionReason, setDecisionReason] = useState("");
  const [acting, setActing] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [qRes, accRes, stRes, repRes] = await Promise.all([
        apiRequest<{ orders: QueueOrder[] }>("/verification/queue"),
        apiRequest<{ accounts: ReceivingAccount[] }>("/verification/bank-accounts"),
        apiRequest<{ lines: StatementLine[] }>("/verification/statements"),
        apiRequest<AccountabilityReport>("/verification/accountability"),
      ]);
      setQueue(qRes.orders);
      setAccounts(accRes.accounts);
      setSelectedAccountId((prev) => prev || accRes.accounts[0]?.id || "");
      setStatementLines(stRes.lines);
      setAccountability(repRes);
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

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const fmt = file.name.toLowerCase().endsWith(".json") ? "JSON" : "CSV";
    setStatementFormat(fmt);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseStatementLocally(String(reader.result ?? ""), fmt);
        setLocalLines(parsed);
        setError(null);
      } catch (err) {
        setError(`Could not parse file locally: ${(err as Error).message}`);
      }
    };
    reader.readAsText(file);
  }

  async function handleUploadFiltered() {
    if (!selectedAccountId) {
      setError("Select a receiving OPay account first.");
      return;
    }
    const kept = localLines.filter((l) => l.keep && l.transactionReference.trim());
    if (kept.length === 0) {
      setError("Keep at least one relevant marketplace transaction line before uploading.");
      return;
    }
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest("/verification/statements", {
        method: "POST",
        body: JSON.stringify({
          receivingBankAccountId: selectedAccountId,
          fileName,
          format: statementFormat,
          lines: kept.map((l) => ({
            transactionReference: l.transactionReference,
            amountKobo: l.amountKobo,
            creditedAt: l.creditedAt,
            senderName: l.senderName,
            narration: l.narration,
          })),
        }),
      });
      setNotice(`Uploaded ${kept.length} filtered transaction line(s). Unchecked personal lines stayed local.`);
      setLocalLines([]);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  function openOrderDrawer(order: QueueOrder) {
    setSelectedOrder(order);
    setSelectedLineIds([]);
    setManualMode(false);
    setManualRef(order.proofs[0]?.bankReference ?? "");
    setManualAmountNaira((Number(BigInt(order.fiatAmountKobo)) / 100).toString());
    setDecisionReason("");
  }

  async function handleApproveCredit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedOrder || !selectedAccountId) return;
    setActing(true);
    setError(null);
    setNotice(null);
    try {
      const payload: Record<string, unknown> = {
        receivingBankAccountId: selectedAccountId,
        paymentProofId: selectedOrder.proofs[0]?.id,
        bankCreditConfirmed: true,
        reason: decisionReason.trim() || "Verified OPay credit",
      };
      if (manualMode) {
        payload.manualVerificationException = true;
        payload.bankCreditReference = manualRef.trim();
        payload.bankCreditAmountKobo = BigInt(Math.round(Number(manualAmountNaira) * 100)).toString();
      } else {
        payload.statementLineIds = selectedLineIds;
      }

      const res = await apiRequest<{ orderStatus: string; cumulativeCreditsKobo: string }>(
        `/verification/orders/${selectedOrder.id}/approve`,
        {
          method: "POST",
          body: JSON.stringify(payload),
        }
      );
      setNotice(
        `Credit recorded. Order status: ${res.orderStatus} (Cumulative verified: ${formatNaira(res.cumulativeCreditsKobo)}).`
      );
      setSelectedOrder(null);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActing(false);
    }
  }

  async function handleRejectOrder() {
    if (!selectedOrder) return;
    if (decisionReason.trim().length < 3) {
      setError("Enter a rejection reason (at least 3 characters).");
      return;
    }
    setActing(true);
    setError(null);
    try {
      await apiRequest(`/verification/orders/${selectedOrder.id}/reject`, {
        method: "POST",
        body: JSON.stringify({
          paymentProofId: selectedOrder.proofs[0]?.id,
          reason: decisionReason.trim(),
        }),
      });
      setNotice("Payment proof rejected.");
      setSelectedOrder(null);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActing(false);
    }
  }

  async function handleReverseDecision(decisionId: string) {
    if (!selectedOrder) return;
    if (decisionReason.trim().length < 5) {
      setError("Enter a reversal reason (at least 5 characters) before reversing a verified credit.");
      return;
    }
    setActing(true);
    setError(null);
    try {
      await apiRequest(`/verification/orders/${selectedOrder.id}/reverse`, {
        method: "POST",
        body: JSON.stringify({
          decisionId,
          reason: decisionReason.trim(),
        }),
      });
      setNotice("Verified credit reversed in full and commission adjusted.");
      setSelectedOrder(null);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActing(false);
    }
  }

  const unmatchedLines = statementLines.filter(
    (l) => (l.reconciliationStatus ?? l.status) === "UNMATCHED"
  );

  return (
    <div className="space-y-6">
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

      {/* Financial Accountability Strip */}
      {accountability && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Net Verified Payments"
            value={formatNaira(accountability.paymentsVerified.netVerifiedCustomerPaymentsKobo)}
            accentColor="text-[#059669]"
          />
          <StatCard
            label="Awaiting Verification"
            value={formatNaira(accountability.outstandingBalancesKobo)}
            accentColor="text-amber-600"
          />
          <StatCard
            label="Partner Commissions"
            value={formatNaira(accountability.commissionEntitlements.totalNetPartnerEntitlementKobo)}
          />
          <StatCard
            label="Owner Share"
            value={formatNaira(accountability.commissionEntitlements.totalNetOwnerEntitlementKobo)}
          />
        </div>
      )}

      {/* Local Statement Pre-Filter & Upload */}
      <Card
        title="OPay Statement Reconciliation (Privacy-Preserving)"
        subtitle="Filter out unrelated personal transactions locally in your browser before uploading marketplace credits. Uploading never auto-approves orders."
      >
        <div className="grid gap-4 sm:grid-cols-3 items-end">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Receiving OPay Account</label>
            <select
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
            >
              <option value="">Select receiving account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.bankName} • {a.accountNumber} ({a.accountName})
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Choose OPay CSV or JSON Statement
            </label>
            <input
              type="file"
              accept=".csv,.json"
              onChange={handleFileChange}
              className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-50"
            />
          </div>
        </div>

        {localLines.length > 0 && (
          <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium text-slate-700">
                Preview ({localLines.filter((l) => l.keep).length} of {localLines.length} lines selected for upload)
              </p>
              <Button size="sm" onClick={handleUploadFiltered} disabled={uploading}>
                {uploading ? "Uploading…" : "Upload Selected Marketplace Lines"}
              </Button>
            </div>
            <div className="max-h-56 overflow-y-auto divide-y divide-slate-100 rounded-lg border border-slate-200">
              {localLines.map((line) => (
                <label
                  key={line.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-slate-50 cursor-pointer"
                >
                  <div className="flex items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={line.keep}
                      onChange={(e) =>
                        setLocalLines((prev) =>
                          prev.map((x) => (x.id === line.id ? { ...x, keep: e.target.checked } : x))
                        )
                      }
                    />
                    <span className="font-mono-tabular font-medium text-slate-900">
                      {line.transactionReference}
                    </span>
                    <span className="text-slate-500">{line.senderName ?? "—"}</span>
                  </div>
                  <span className="font-mono-tabular font-semibold text-slate-900">
                    {formatNaira(line.amountKobo)}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* Verification Queue */}
      <Card
        title="Payment Verification Queue"
        subtitle="Select an order to link confirmed OPay statement credits, approve partial/split payments, or reject invalid proofs."
      >
        {loading ? (
          <p className="text-sm text-slate-500">Loading verification queue…</p>
        ) : queue.length === 0 ? (
          <p className="text-sm text-slate-500">No orders currently awaiting verification.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {queue.map((ord) => (
              <div
                key={ord.id}
                className="py-4 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
              >
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono-tabular text-sm font-semibold text-slate-900">
                      {ord.orderNumber}
                    </span>
                    <OrderStatusBadge status={ord.status} />
                    {ord.paymentExceptionType !== "NONE" && (
                      <StatusBadge label={ord.paymentExceptionType.replaceAll("_", " ")} tone="warning" />
                    )}
                  </div>
                  <p className="text-xs text-slate-600">
                    Customer: <span className="font-medium text-slate-900">{ord.customer.fullName}</span> • Required:{" "}
                    <span className="font-mono-tabular font-semibold">{formatNaira(ord.fiatAmountKobo)}</span> • Verified:{" "}
                    <span className="font-mono-tabular font-semibold text-[#059669]">
                      {formatNaira(ord.verifiedGrossFiatKobo)}
                    </span>
                  </p>
                  {ord.proofs[0] && (
                    <p className="text-[11px] text-slate-500">
                      Latest Proof: Ref <span className="font-mono-tabular">{ord.proofs[0].bankReference}</span> • Sender:{" "}
                      {ord.proofs[0].senderAccountName} ({formatNaira(ord.proofs[0].claimedAmountKobo)})
                    </p>
                  )}
                </div>

                <Button variant="secondary" size="sm" onClick={() => openOrderDrawer(ord)}>
                  Review Order
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Slide-Over Review Drawer */}
      <SlideOver
        open={Boolean(selectedOrder)}
        onClose={() => setSelectedOrder(null)}
        title={selectedOrder ? `Verify ${selectedOrder.orderNumber}` : ""}
        subtitle={
          selectedOrder
            ? `Required: ${formatNaira(selectedOrder.fiatAmountKobo)} • Verified so far: ${formatNaira(selectedOrder.verifiedGrossFiatKobo)}`
            : undefined
        }
      >
        {selectedOrder && (
          <div className="space-y-5">
            <form onSubmit={handleApproveCredit} className="space-y-4">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-slate-900">
                  Link Confirmed OPay Statement Credits
                </label>
                <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={manualMode}
                    onChange={(e) => setManualMode(e.target.checked)}
                  />
                  Manual exception entry
                </label>
              </div>

              {!manualMode ? (
                <div className="max-h-48 overflow-y-auto divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {unmatchedLines.length === 0 ? (
                    <p className="p-3 text-xs text-slate-500">
                      No unmatched statement lines uploaded yet. Upload a filtered statement or use manual exception entry.
                    </p>
                  ) : (
                    unmatchedLines.map((line) => (
                      <label
                        key={line.id}
                        className="flex items-center justify-between gap-2 px-3 py-2 text-xs hover:bg-slate-50 cursor-pointer"
                      >
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={selectedLineIds.includes(line.id)}
                            onChange={(e) =>
                              setSelectedLineIds((prev) =>
                                e.target.checked ? [...prev, line.id] : prev.filter((id) => id !== line.id)
                              )
                            }
                          />
                          <div>
                            <p className="font-mono-tabular font-medium text-slate-900">
                              {line.transactionReference}
                            </p>
                            <p className="text-[11px] text-slate-500">{line.senderName ?? "—"}</p>
                          </div>
                        </div>
                        <span className="font-mono-tabular font-semibold text-slate-900">
                          {formatNaira(line.amountKobo)}
                        </span>
                      </label>
                    ))
                  )}
                </div>
              ) : (
                <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/50 p-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Confirmed Bank Reference
                    </label>
                    <input
                      type="text"
                      required
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-tabular text-xs"
                      value={manualRef}
                      onChange={(e) => setManualRef(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Confirmed Amount (₦)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      required
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-tabular text-xs"
                      value={manualAmountNaira}
                      onChange={(e) => setManualAmountNaira(e.target.value)}
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Audit Reason ({manualMode ? "min 10 characters for manual override" : "required for all decisions"})
                </label>
                <input
                  type="text"
                  required
                  minLength={manualMode ? 10 : 3}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
                  placeholder="e.g. Confirmed OPay credit on statement"
                  value={decisionReason}
                  onChange={(e) => setDecisionReason(e.target.value)}
                />
              </div>

              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={acting} className="flex-1">
                  {acting ? "Processing…" : "Confirm & Approve Credit"}
                </Button>
                <Button type="button" variant="danger" disabled={acting} onClick={handleRejectOrder}>
                  Reject Proof
                </Button>
              </div>
            </form>

            {isOwner && selectedOrder.decisions.length > 0 && (
              <div className="border-t border-slate-200 pt-4 space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Approved Decisions (Owner Reversal)
                </h3>
                {(() => {
                  const reversedIds = new Set(
                    selectedOrder.decisions
                      .filter((d) => d.decision === "REVERSED" && d.supersedesDecisionId)
                      .map((d) => d.supersedesDecisionId as string)
                  );
                  return selectedOrder.decisions
                    .filter((d) => d.decision === "APPROVED" && !reversedIds.has(d.id))
                    .map((d) => (
                      <div
                        key={d.id}
                        className="flex items-center justify-between rounded-lg border border-slate-200 p-3 text-xs"
                      >
                        <div>
                          <p className="font-mono-tabular font-semibold text-slate-900">
                            {d.bankCreditAmountKobo ? formatNaira(d.bankCreditAmountKobo) : "—"}
                          </p>
                          <p className="text-slate-500">
                            Ref: {d.bankCreditReference ?? "—"} • {formatDateTime(d.createdAt)}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={acting}
                          onClick={() => handleReverseDecision(d.id)}
                        >
                          Full Reversal
                        </Button>
                      </div>
                    ));
                })()}
              </div>
            )}
          </div>
        )}
      </SlideOver>
    </div>
  );
}
