"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { buildWhatsAppReceiptUrl } from "@bigola/shared";
import { CustomerShell } from "@/components/CustomerShell";
import { Card } from "@/components/ui/Card";
import { Button, CopyButton } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/Badge";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { apiRequest } from "@/lib/api";
import { formatDateTime, formatNaira, formatTrillions, type BadgeTone } from "@/lib/format";

interface CustomerOrderDetail {
  id: string;
  orderNumber: string;
  paymentReference: string;
  channel: string;
  orderType: string;
  status: string;
  paymentExceptionType?: string;
  refundFinancialStatus?: string;
  recipientLagoslifeUsername: string;
  gameAmountRequested: string;
  gameAmountDelivered?: string;
  fulfilledAmount: string;
  fiatAmountKobo: string;
  verifiedGrossFiatKobo: string;
  confirmedRefundedKobo?: string;
  expiresAt: string | null;
  createdAt: string;
}

interface ReceivingBankAccountOption {
  id: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  isDefault: boolean;
}

interface PaymentInstructionsResponse {
  orderId: string;
  orderNumber: string;
  paymentReference: string;
  fiatAmountKobo: string;
  verifiedGrossFiatKobo: string;
  status: string;
  expiresAt: string | null;
  whatsappNumber?: string | null;
  whatsappNumberSecondary?: string | null;
  receivingAccounts: ReceivingBankAccountOption[];
}

interface CustomerDisbursementJobProgress {
  id: string;
  orderId: string;
  status: "PENDING" | "RUNNING" | "PAUSED" | "PARTIAL" | "COMPLETED" | "FAILED";
  totalAmount: string;
  deliveredAmount: string;
  remainingAmount: string;
  totalChunks: number;
  completedChunks: number;
  progressPercent: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

function parseBigIntSafe(raw: string | undefined | null): bigint {
  if (!raw) return 0n;
  try {
    return BigInt(String(raw).split(".")[0]?.trim() || "0");
  } catch {
    return 0n;
  }
}

function formatGameCurrency(raw: string | bigint): string {
  try {
    const val = typeof raw === "bigint" ? raw : parseBigIntSafe(raw);
    const oneTrillion = 1_000_000_000_000n;
    const oneBillion = 1_000_000_000n;
    if (val >= oneTrillion && val % oneTrillion === 0n) {
      return formatTrillions(val.toString());
    }
    if (val >= oneBillion) {
      const b = Number(val) / 1_000_000_000;
      const t = Number(val) / 1_000_000_000_000;
      if (val >= oneTrillion) {
        return `${t.toLocaleString("en-US", { maximumFractionDigits: 2 })}T (${b.toLocaleString("en-US", { maximumFractionDigits: 0 })}B)`;
      }
      return `${b.toLocaleString("en-US", { maximumFractionDigits: 2 })}B`;
    }
    return val.toLocaleString("en-US");
  } catch {
    return String(raw);
  }
}

function getOrderTone(status: string): BadgeTone {
  switch (status) {
    case "COMPLETED":
    case "PAYMENT_VERIFIED":
    case "READY_FOR_FULFILMENT":
      return "success";
    case "QUEUED":
    case "DISBURSING":
    case "RUNNING":
      return "info";
    case "PARTIALLY_FULFILLED":
    case "PAYMENT_SUBMITTED":
    case "AWAITING_PAYMENT":
    case "PAUSED":
      return "warning";
    case "PAYMENT_EXCEPTION_REVIEW":
    case "CANCELLED":
    case "EXPIRED":
    case "FAILED":
      return "danger";
    default:
      return "neutral";
  }
}

export default function OrderDetailClient() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const rawParamId = params?.id ?? "";
  const [resolvedOrderId, setResolvedOrderId] = useState(rawParamId === "_" ? "" : rawParamId);

  useEffect(() => {
    if (rawParamId && rawParamId !== "_") {
      setResolvedOrderId(rawParamId);
      return;
    }
    const segment = window.location.pathname.split("/").filter(Boolean).pop() ?? "";
    if (segment && segment !== "_") {
      setResolvedOrderId(segment);
    }
  }, [rawParamId]);

  const orderId = resolvedOrderId;

  const [order, setOrder] = useState<CustomerOrderDetail | null>(null);
  const [instructions, setInstructions] = useState<PaymentInstructionsResponse | null>(null);
  const [disbursementJobs, setDisbursementJobs] = useState<CustomerDisbursementJobProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { pushToast } = useToast();

  // Payment proof submission state (aligned with POST /orders/:orderId/payment-proof)
  const [receivingBankAccountId, setReceivingBankAccountId] = useState("");
  const [senderAccountName, setSenderAccountName] = useState("");
  const [bankReference, setBankReference] = useState("");
  const [amountPaidNaira, setAmountPaidNaira] = useState("");
  const [proofFileKey, setProofFileKey] = useState("");
  const [isSplitTransfer, setIsSplitTransfer] = useState(false);

  // Cancellation confirmation state
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const loadOrderAndProgress = useCallback(
    async (silent = false) => {
      if (!orderId) return;
      if (silent) setRefreshing(true);
      else setLoading(true);

      try {
        const [orderRes, disbRes, instrRes] = await Promise.all([
          apiRequest<{ order: CustomerOrderDetail }>(`/customer/orders/${orderId}`),
          apiRequest<{ jobs: CustomerDisbursementJobProgress[] }>(
            `/customer/orders/${orderId}/disbursements`
          ).catch(() => ({ jobs: [] })),
          apiRequest<PaymentInstructionsResponse>(`/orders/${orderId}/payment-instructions`).catch(
            () => null
          ),
        ]);

        setOrder(orderRes.order);
        setDisbursementJobs(disbRes.jobs ?? []);
        if (instrRes) {
          setInstructions(instrRes);
          if (!receivingBankAccountId && instrRes.receivingAccounts?.[0]?.id) {
            setReceivingBankAccountId(instrRes.receivingAccounts[0].id);
          }
        }
        if (!amountPaidNaira && orderRes.order?.fiatAmountKobo) {
          const naira = Number(orderRes.order.fiatAmountKobo) / 100;
          if (Number.isFinite(naira) && naira > 0) {
            setAmountPaidNaira(String(naira));
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load order details.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [orderId, amountPaidNaira, receivingBankAccountId]
  );

  useEffect(() => {
    void loadOrderAndProgress(false);
  }, [loadOrderAndProgress]);

  const handleSubmitProof = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!order) return;
    if (!receivingBankAccountId) {
      setError("Please select the receiving bank account you transferred to.");
      return;
    }
    setBusy(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const paidKobo = BigInt(Math.round(Number(amountPaidNaira) * 100));
      await apiRequest(`/orders/${order.id}/payment-proof`, {
        method: "POST",
        body: JSON.stringify({
          receivingBankAccountId,
          bankReference: bankReference.trim(),
          senderAccountName: senderAccountName.trim(),
          claimedAmountKobo: paidKobo.toString(),
          proofFileKey:
            proofFileKey.trim() || `receipt_${order.orderNumber}_${Date.now()}.png`,
          isSplitTransfer,
        }),
      });
      setSuccessMsg(
        "Payment proof submitted! Our verification desk will confirm bank credit before queuing your currency transfer."
      );
      pushToast({ title: "Payment proof submitted", tone: "success" });
      setBankReference("");
      await loadOrderAndProgress(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit payment proof.");
    } finally {
      setBusy(false);
    }
  };

  const handleCancelOrder = async () => {
    if (!order) return;
    setBusy(true);
    setError(null);
    setSuccessMsg(null);
    try {
      await apiRequest(`/customer/orders/${order.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({
          reason: cancelReason.trim() || "Cancelled by customer",
        }),
      });
      setConfirmCancelOpen(false);
      setSuccessMsg("Order cancelled and reserved inventory released.");
      pushToast({ title: "Order cancelled", tone: "info" });
      await loadOrderAndProgress(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel order.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <CustomerShell>
        <div className="mx-auto max-w-3xl space-y-4">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </CustomerShell>
    );
  }

  if (!order) {
    return (
      <CustomerShell>
        <Card>
          <p className="text-sm text-red-600">{error ?? "Order not found."}</p>
          <Button
            className="mt-4"
            variant="secondary"
            onClick={() => router.push("/marketplace/orders")}
          >
            Back to Orders
          </Button>
        </Card>
      </CustomerShell>
    );
  }

  const requestedUnits = parseBigIntSafe(order.gameAmountRequested);
  const deliveredUnits = parseBigIntSafe(
    order.fulfilledAmount || order.gameAmountDelivered || "0"
  );
  const remainingUnits = requestedUnits > deliveredUnits ? requestedUnits - deliveredUnits : 0n;
  const overallPercent =
    requestedUnits > 0n
      ? Math.min(100, Number((deliveredUnits * 100n) / requestedUnits))
      : 0;

  const fiatRequestedKobo = parseBigIntSafe(order.fiatAmountKobo);
  const fiatVerifiedKobo = parseBigIntSafe(order.verifiedGrossFiatKobo);
  const isPaymentConfirmed =
    fiatRequestedKobo > 0n && fiatVerifiedKobo >= fiatRequestedKobo;

  const activeJob = disbursementJobs[0] ?? null;
  const totalChunksCompleted = disbursementJobs.reduce((sum, j) => sum + j.completedChunks, 0);
  const totalChunksPlanned = disbursementJobs.reduce((sum, j) => sum + j.totalChunks, 0);

  return (
    <CustomerShell>
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <button
              type="button"
              onClick={() => router.push("/marketplace/orders")}
              className="text-xs font-semibold text-[#059669] hover:underline"
            >
              &larr; Back to My Orders
            </button>
            <h1 className="mt-1 font-display text-2xl font-extrabold tracking-tight text-[#0B1324]">
              Order {order.orderNumber}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span>Payment Reference:</span>
              <span className="font-mono-tabular font-semibold text-[#0B1324]">
                {order.paymentReference}
              </span>
              <CopyButton value={order.paymentReference} label="Copy" />
              <span>&middot; Created {formatDateTime(order.createdAt)}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => loadOrderAndProgress(true)}
              disabled={refreshing}
            >
              {refreshing ? "Refreshing..." : "Refresh Status"}
            </Button>
            <StatusBadge label={order.status} tone={getOrderTone(order.status)} />
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {successMsg && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {successMsg}
          </div>
        )}

        {/* 1. Payment Confirmation & Fulfilment Status Summary */}
        <Card>
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
              <div>
                <h2 className="font-display text-sm font-bold text-[#0B1324]">
                  Payment Confirmation &amp; Fulfilment Overview
                </h2>
                <p className="text-xs text-slate-500">
                  LagosLife Recipient:{" "}
                  <strong className="text-[#059669]">@{order.recipientLagoslifeUsername}</strong>
                </p>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge
                  label={
                    isPaymentConfirmed
                      ? "PAYMENT CONFIRMED"
                      : order.status === "PAYMENT_SUBMITTED"
                        ? "AWAITING BANK VERIFICATION"
                        : order.status === "PAYMENT_EXCEPTION_REVIEW"
                          ? "PAYMENT EXCEPTION REVIEW"
                          : "PAYMENT PENDING"
                  }
                  tone={
                    isPaymentConfirmed
                      ? "success"
                      : order.status === "PAYMENT_EXCEPTION_REVIEW"
                        ? "danger"
                        : "warning"
                  }
                />
              </div>
            </div>

            {/* Requested / Delivered / Remaining / Payment Grid */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-[11px] font-medium text-slate-500">Requested Amount</div>
                <div className="mt-1 text-base font-bold text-slate-900 tabular-nums">
                  {formatGameCurrency(requestedUnits)}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-[11px] font-medium text-slate-500">Amount Delivered</div>
                <div className="mt-1 text-base font-bold text-emerald-700 tabular-nums">
                  {formatGameCurrency(deliveredUnits)}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-[11px] font-medium text-slate-500">Remaining Amount</div>
                <div className="mt-1 text-base font-bold text-amber-700 tabular-nums">
                  {formatGameCurrency(remainingUnits)}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-[11px] font-medium text-slate-500">Confirmed Payment</div>
                <div className="mt-1 text-sm font-bold text-slate-900 tabular-nums">
                  {formatNaira(order.verifiedGrossFiatKobo)} / {formatNaira(order.fiatAmountKobo)}
                </div>
              </div>
            </div>

            {/* 2. Live Currency Delivery Progress & Completion Status */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-bold text-slate-900">
                    LagosLife Currency Delivery Progress
                  </div>
                  <div className="text-[11px] text-slate-500">
                    Transfers execute in verified chunks of up to 100B directly to @{order.recipientLagoslifeUsername}
                  </div>
                </div>
                <span className="text-sm font-bold text-slate-900 tabular-nums">
                  {overallPercent}% Delivered
                </span>
              </div>

              <div className="h-3 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full transition-all duration-300 ${
                    order.status === "COMPLETED"
                      ? "bg-[#059669]"
                      : activeJob?.status === "PAUSED"
                        ? "bg-amber-500"
                        : "bg-[#0B1324]"
                  }`}
                  style={{ width: `${overallPercent}%` }}
                />
              </div>

              {totalChunksPlanned > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-slate-600">
                  <span>
                    Completed Transfer Chunks:{" "}
                    <strong className="text-slate-900">
                      {totalChunksCompleted} / {totalChunksPlanned}
                    </strong>
                  </span>
                  {activeJob?.completedAt ? (
                    <span>Completed {formatDateTime(activeJob.completedAt)}</span>
                  ) : activeJob?.startedAt ? (
                    <span>Started {formatDateTime(activeJob.startedAt)}</span>
                  ) : null}
                </div>
              )}

              {/* Completion & Status Banners */}
              {order.status === "COMPLETED" ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs font-medium text-emerald-800">
                  Delivery Complete: All {formatGameCurrency(requestedUnits)} has been delivered to{" "}
                  <strong>@{order.recipientLagoslifeUsername}</strong> on LagosLife.
                </div>
              ) : order.status === "DISBURSING" || order.status === "PARTIALLY_FULFILLED" ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs font-medium text-[#0B1324]">
                  {activeJob?.status === "PAUSED"
                    ? `Transfer is temporarily paused at ${formatGameCurrency(deliveredUnits)} delivered while our operations team verifies the next chunk. Remaining ${formatGameCurrency(remainingUnits)} is safely reserved.`
                    : `Delivery in Progress: ${formatGameCurrency(deliveredUnits)} delivered so far; ${formatGameCurrency(remainingUnits)} remaining. Transfers run in 100B chunks with a 30.5-second game cooldown between transfers.`}
                </div>
              ) : order.status === "READY_FOR_FULFILMENT" || order.status === "QUEUED" ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 text-xs font-medium text-emerald-900">
                  Payment Confirmed: Your order for {formatGameCurrency(requestedUnits)} is verified and queued for LagosLife currency delivery to @{order.recipientLagoslifeUsername}.
                </div>
              ) : order.status === "PAYMENT_SUBMITTED" ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs font-medium text-amber-900">
                  Payment Proof Received: Our verification desk is matching your bank transfer against our statement before initiating currency delivery.
                </div>
              ) : order.status === "PAYMENT_EXCEPTION_REVIEW" ? (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs font-medium text-rose-800">
                  Payment Exception Review: Your payment requires manual review by our verification desk. You may submit an additional proof below if you made a split transfer.
                </div>
              ) : null}
            </div>
          </div>
        </Card>

        {/* 3. Payment Instructions & Proof Submission (when awaiting payment / exception review) */}
        {(order.status === "AWAITING_PAYMENT" ||
          order.status === "PAYMENT_SUBMITTED" ||
          order.status === "PAYMENT_EXCEPTION_REVIEW") && (
          <Card>
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  Bank Transfer Instructions &amp; Payment Proof
                </h2>
                <p className="mt-1 text-xs text-slate-600">
                  Transfer{" "}
                  <strong className="text-slate-900">{formatNaira(order.fiatAmountKobo)}</strong> and
                  include reference{" "}
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono font-bold text-slate-900">
                    {order.paymentReference}
                  </span>{" "}
                  in your bank transfer narration.
                </p>
              </div>

              {instructions?.receivingAccounts && instructions.receivingAccounts.length > 0 && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {instructions.receivingAccounts.map((acc) => (
                    <div
                      key={acc.id}
                      onClick={() => setReceivingBankAccountId(acc.id)}
                      className={`cursor-pointer rounded-xl border p-3.5 text-xs transition ${
                        receivingBankAccountId === acc.id
                          ? "border-[#059669] bg-emerald-50/40 ring-1 ring-[#059669]/20"
                          : "border-slate-200 bg-slate-50 hover:bg-slate-100"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-[#0B1324]">{acc.bankName}</span>
                        {acc.isDefault && (
                          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                            Recommended
                          </span>
                        )}
                      </div>
                      <div className="mt-1.5 flex items-center justify-between gap-2">
                        <span className="font-mono-tabular text-sm font-bold text-[#0B1324]">
                          {acc.accountNumber}
                        </span>
                        <CopyButton value={acc.accountNumber} label="Copy" />
                      </div>
                      <div className="mt-0.5 text-slate-600">{acc.accountName}</div>
                    </div>
                  ))}
                </div>
              )}

              {(() => {
                const details = {
                  orderNumber: order.orderNumber,
                  paymentReference: order.paymentReference,
                  amountDueNaira: formatNaira(order.fiatAmountKobo),
                  gameAmountLabel: formatGameCurrency(requestedUnits),
                  recipientUsername: order.recipientLagoslifeUsername,
                };
                const primaryHref = buildWhatsAppReceiptUrl(instructions?.whatsappNumber, details);
                const secondaryHref = buildWhatsAppReceiptUrl(
                  instructions?.whatsappNumberSecondary,
                  details
                );
                if (!primaryHref && !secondaryHref) {
                  return (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
                      Send your transfer receipt on WhatsApp so we can confirm payment and start delivery.
                    </div>
                  );
                }
                return (
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-4 space-y-2.5">
                    <div className="text-xs font-semibold text-emerald-950">
                      Step 2: Send your OPay transfer receipt on WhatsApp for fast confirmation
                    </div>
                    <div className={`grid gap-2.5 ${primaryHref && secondaryHref ? "sm:grid-cols-2" : "grid-cols-1"}`}>
                      {primaryHref && (
                        <a
                          href={primaryHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex w-full items-center justify-center rounded-xl bg-[#059669] px-5 py-3.5 text-sm font-bold text-white shadow-sm transition hover:bg-[#047857]"
                        >
                          {secondaryHref ? "SEND RECEIPT ON WHATSAPP (LINE 1)" : "SEND PAYMENT RECEIPT ON WHATSAPP"}
                        </a>
                      )}
                      {secondaryHref && (
                        <a
                          href={secondaryHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex w-full items-center justify-center rounded-xl bg-[#0B1324] px-5 py-3.5 text-sm font-bold text-white shadow-sm transition hover:bg-slate-800"
                        >
                          {primaryHref ? "SEND RECEIPT ON WHATSAPP (LINE 2)" : "SEND PAYMENT RECEIPT ON WHATSAPP"}
                        </a>
                      )}
                    </div>
                    <p className="text-[11px] text-emerald-900/80">
                      Opens WhatsApp with your Order ID, Payment Reference, Amount, and LagosLife username prefilled.
                    </p>
                  </div>
                );
              })()}

              {order.status === "AWAITING_PAYMENT" && !confirmCancelOpen && (
                <div className="flex justify-end border-t border-slate-100 pt-3">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setConfirmCancelOpen(true)}
                    disabled={busy}
                  >
                    Cancel Order
                  </Button>
                </div>
              )}

              {order.status === "AWAITING_PAYMENT" && confirmCancelOpen && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 p-3.5 space-y-2.5 text-xs">
                  <div className="font-bold text-rose-900">
                    Confirm Order Cancellation
                  </div>
                  <p className="text-rose-800">
                    Are you sure you want to cancel Order {order.orderNumber} and release your reserved inventory?
                  </p>
                  <input
                    type="text"
                    placeholder="Reason for cancellation (optional)"
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                    className="w-full rounded border border-rose-300 bg-white px-2.5 py-1.5 text-xs"
                  />
                  <div className="flex gap-2">
                    <Button onClick={handleCancelOrder} disabled={busy}>
                      {busy ? "Cancelling..." : "Yes, Cancel Order"}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => setConfirmCancelOpen(false)}
                      disabled={busy}
                    >
                      Keep Order
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </Card>
        )}
      </div>
    </CustomerShell>
  );
}
