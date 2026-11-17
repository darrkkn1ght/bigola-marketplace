"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { OwnerShell } from "@/components/OwnerShell";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/Badge";
import { SlideOver } from "@/components/ui/SlideOver";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { ONE_TRILLION } from "@bigola/shared";
import { apiRequest } from "@/lib/api";
import { formatDateTime, formatNaira, formatTrillions, type BadgeTone } from "@/lib/format";

interface OrderSummary {
  id: string;
  orderNumber: string;
  channel: string;
  status: string;
  refundFinancialStatus: string;
  recipientLagoslifeUsername: string;
  gameAmountRequested: string;
  fulfilledAmount: string;
  fiatAmountKobo: string;
  verifiedGrossFiatKobo: string;
  confirmedRefundedKobo: string;
  createdAt: string;
  customer?: {
    id: string;
    fullName: string;
    lagoslifeUsername: string;
  };
  partner?: {
    id: string;
    displayName: string;
    referralCode: string;
  } | null;
}

interface DisbursementChunkView {
  id: string;
  jobId: string;
  sourceAccountId: string;
  sourceSlotCode: string | null;
  sourceAccountLabel: string | null;
  sourceLagoslifeUsername: string | null;
  recipientUsername: string;
  resolvedTargetId: string | null;
  amount: string;
  idempotencyKey: string;
  status:
    | "PENDING"
    | "IN_FLIGHT"
    | "SUCCEEDED"
    | "FAILED_RETRYABLE"
    | "AMBIGUOUS_MANUAL_REVIEW"
    | "FAILED_TERMINAL";
  attemptCount: number;
  httpStatus: number | null;
  errorMessage: string | null;
  reconciliationNote: string | null;
  executedAt: string | null;
  createdAt: string;
}

interface DisbursementJobView {
  id: string;
  orderId: string;
  totalAmount: string;
  deliveredAmount: string;
  remainingAmount: string;
  status: "PENDING" | "RUNNING" | "PAUSED" | "PARTIAL" | "COMPLETED" | "FAILED";
  totalChunks: number;
  completedChunks: number;
  progressPercent: number;
  hasAmbiguousChunks: boolean;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  chunks: DisbursementChunkView[];
}

interface OrderOperationalDetail {
  id: string;
  orderNumber: string;
  paymentReference: string;
  channel: string;
  orderType: string;
  status: string;
  paymentExceptionType?: string;
  refundFinancialStatus: string;
  recipientLagoslifeUsername: string;
  gameAmountRequested: string;
  gameAmountDelivered?: string;
  fulfilledAmount: string;
  remainingFulfilmentAmount?: string;
  fiatAmountKobo: string;
  verifiedGrossFiatKobo: string;
  confirmedRefundedKobo: string;
  remainingRefundableKobo?: string;
  createdAt: string;
  customer: {
    id: string;
    fullName: string;
    email: string | null;
    phone: string;
    lagoslifeUsername: string;
    category: string;
  };
  partner: {
    id: string;
    displayName: string;
    referralCode: string;
  } | null;
  paymentProofs?: Array<{
    id: string;
    bankName: string;
    bankReference: string;
    senderAccountName: string;
    claimedAmountKobo: string;
    verificationStatus: string;
    createdAt: string;
  }>;
  verificationDecisions?: Array<{
    id: string;
    decision: string;
    bankCreditAmountKobo: string;
    bankCreditReference: string | null;
    reason: string | null;
    createdAt: string;
  }>;
  reservations: Array<{
    id: string;
    gameAccountId: string;
    slotCode: string;
    amount: string;
    status: string;
    expiresAt: string | null;
  }>;
  manualFulfilments?: Array<{
    id: string;
    sourceGameAccountId: string;
    slotCode: string;
    deliveredAmount: string;
    externalReference: string;
    notes: string | null;
    confirmedAt: string;
  }>;
  refundRequests: Array<{
    id: string;
    scope: string;
    requestedAmountKobo: string;
    confirmedRefundReference: string | null;
    currentStatus: string;
    createdAt: string;
  }>;
  disbursementJobs?: DisbursementJobView[];
}

interface InventorySlotOption {
  id: string;
  slotCode: string;
  accountRole: string;
  lagoslifeUsername: string | null;
  healthStatus: string;
  effectiveHealthStatus?: string;
  isStale?: boolean;
  observedBalance: string;
  reservedForOrders: string;
  netAvailableBalance?: string;
  reservableAvailable?: string;
  lastSyncedAt?: string | null;
  sessionConnected?: boolean;
  connectionStatus?: "CONNECTED" | "SESSION_EXPIRED" | "DISCONNECTED";
  eligibleForFulfilment?: boolean;
}

interface ResolvedRecipientMeta {
  id: string;
  username: string;
  name: string | null;
}

const CANONICAL_SLOTS = [
  "MAIN_TREASURY",
  "RESERVE_1",
  "RESERVE_2",
  "RESERVE_3",
  "RESERVE_4",
  "RESERVE_5",
  "RESERVE_6",
  "RESERVE_7",
  "RESERVE_8",
] as const;

const SLOT_LABELS: Record<string, string> = {
  MAIN_TREASURY: "Main Treasury (bigola2823)",
  RESERVE_1: "Reserve 1",
  RESERVE_2: "Reserve 2",
  RESERVE_3: "Reserve 3",
  RESERVE_4: "Reserve 4",
  RESERVE_5: "Reserve 5",
  RESERVE_6: "Reserve 6",
  RESERVE_7: "Reserve 7",
  RESERVE_8: "Reserve 8",
};

function makeEmptySlotFlags(): Record<string, boolean> {
  return Object.fromEntries(CANONICAL_SLOTS.map((s) => [s, false]));
}

function makeEmptySlotStrings(): Record<string, string> {
  return Object.fromEntries(CANONICAL_SLOTS.map((s) => [s, ""]));
}

const ONE_BILLION = 1_000_000_000n;
const MAX_CHUNK_UNITS = 100_000_000_000n; // 100B

const STATUS_FILTERS = [
  { label: "All Orders", value: "" },
  { label: "AWAITING PAYMENT", value: "AWAITING_PAYMENT" },
  { label: "PAYMENT SUBMITTED", value: "PAYMENT_SUBMITTED" },
  { label: "PAYMENT EXCEPTION REVIEW", value: "PAYMENT_EXCEPTION_REVIEW" },
  { label: "READY FOR FULFILMENT", value: "READY_FOR_FULFILMENT" },
  { label: "QUEUED", value: "QUEUED" },
  { label: "DISBURSING", value: "DISBURSING" },
  { label: "PARTIALLY FULFILLED", value: "PARTIALLY_FULFILLED" },
  { label: "COMPLETED", value: "COMPLETED" },
  { label: "REFUNDED", value: "REFUNDED" },
  { label: "CANCELLED", value: "CANCELLED" },
  { label: "EXPIRED", value: "EXPIRED" },
];

function parseBigIntSafe(raw: string | undefined | null): bigint {
  if (!raw) return 0n;
  try {
    const clean = String(raw).split(".")[0]?.trim() || "0";
    return BigInt(clean);
  } catch {
    return 0n;
  }
}

function formatBillionsOrTrillions(raw: string | bigint): string {
  try {
    const val = typeof raw === "bigint" ? raw : parseBigIntSafe(raw);
    const oneTrillion = 1_000_000_000_000n;
    if (val >= oneTrillion && val % oneTrillion === 0n) {
      return formatTrillions(val.toString());
    }
    if (val >= ONE_BILLION) {
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

function getBadgeTone(status: string): BadgeTone {
  switch (status) {
    case "COMPLETED":
    case "SUCCEEDED":
    case "CONNECTED":
    case "ACTIVE":
    case "READY_FOR_FULFILMENT":
    case "PAYMENT_VERIFIED":
      return "success";
    case "RUNNING":
    case "IN_FLIGHT":
    case "DISBURSING":
    case "QUEUED":
      return "info";
    case "PAUSED":
    case "PARTIAL":
    case "PARTIALLY_FULFILLED":
    case "AMBIGUOUS_MANUAL_REVIEW":
    case "FAILED_RETRYABLE":
    case "PAYMENT_EXCEPTION_REVIEW":
    case "AWAITING_PAYMENT":
    case "PAYMENT_SUBMITTED":
      return "warning";
    case "FAILED":
    case "FAILED_TERMINAL":
    case "SESSION_EXPIRED":
    case "DISCONNECTED":
    case "CANCELLED":
    case "EXPIRED":
      return "danger";
    default:
      return "neutral";
  }
}

function computeChunkCount(amountUnits: bigint): number {
  if (amountUnits <= 0n) return 0;
  const full = amountUnits / MAX_CHUNK_UNITS;
  const rem = amountUnits % MAX_CHUNK_UNITS;
  return Number(full + (rem > 0n ? 1n : 0n));
}

export default function OwnerOrdersPage() {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBanner, setActionBanner] = useState<string | null>(null);

  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderOperationalDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [inventorySlots, setInventorySlots] = useState<InventorySlotOption[]>([]);
  const [disbursementEnabled, setDisbursementEnabled] = useState<boolean>(false);

  // One-click Confirm Payment & Start Delivery state
  const [confirmDeliverOrder, setConfirmDeliverOrder] = useState<OrderSummary | null>(null);
  const [confirmRefInput, setConfirmRefInput] = useState("");
  const [confirmBusy, setConfirmBusy] = useState(false);

  // Resolved Recipient State
  const [resolvedRecipient, setResolvedRecipient] = useState<ResolvedRecipientMeta | null>(null);
  const [resolvingRecipient, setResolvingRecipient] = useState(false);
  const [recipientResolutionError, setRecipientResolutionError] = useState<string | null>(null);

  // Account Selection & Split Allocation State (in Billions)
  const [selectedSlots, setSelectedSlots] = useState<Record<string, boolean>>(makeEmptySlotFlags);
  const [splitBillionsBySlot, setSplitBillionsBySlot] = useState<Record<string, string>>(makeEmptySlotStrings);
  const [authNote, setAuthNote] = useState("");
  const [disbBusy, setDisbBusy] = useState(false);

  // Explicit Confirmation Dialog States
  const [confirmAuthorizeOpen, setConfirmAuthorizeOpen] = useState(false);
  const [confirmExecuteJobId, setConfirmExecuteJobId] = useState<string | null>(null);
  const [confirmCancelJobId, setConfirmCancelJobId] = useState<string | null>(null);
  const [cancelJobReason, setCancelJobReason] = useState("");

  // Ambiguous Chunk Resolution State
  const [ambiguousNotesByChunk, setAmbiguousNotesByChunk] = useState<Record<string, string>>({});
  const [twoFactorByJob, setTwoFactorByJob] = useState<Record<string, string>>({});

  // Manual Fulfilment fallback state
  const [manualAccountId, setManualAccountId] = useState("");
  const [manualAmountBillions, setManualAmountBillions] = useState("");
  const [manualExternalRef, setManualExternalRef] = useState("");
  const [manualNotes, setManualNotes] = useState("");

  // Refund state
  const [refundScope, setRefundScope] = useState<"FULL" | "PARTIAL">("FULL");
  const [refundAmountNaira, setRefundAmountNaira] = useState("");
  const [refundReason, setRefundReason] = useState("");

  // Direct / Pre-Paid Owner Order state
  const [directOpen, setDirectOpen] = useState(false);
  const [directRecipient, setDirectRecipient] = useState("");
  const [directAmountT, setDirectAmountT] = useState("10");
  const [directPrePaid, setDirectPrePaid] = useState(true);
  const [directReason, setDirectReason] = useState("");
  const [directBusy, setDirectBusy] = useState(false);

  // Worker & Multi-Pipeline Control state
  const [pipelineStatus, setPipelineStatus] = useState<{
    disbursementEnabled: boolean;
    workerHeartbeat: {
      alive: boolean;
      lastHeartbeatAt: string | null;
      service: string | null;
      disbursementEnabled: boolean | null;
      intakePaused?: boolean | null;
      permittedConcurrency?: number | null;
    };
    workerControl: {
      intakePaused: boolean;
      permittedConcurrency: number;
      updatedAt: string | null;
      reason: string | null;
    };
    queueStats: {
      connected: boolean;
      waiting: number;
      active: number;
      delayed: number;
      failed: number;
      completed: number;
    };
    accounts: Array<{
      id: string;
      slotCode: string;
      lagoslifeUsername: string | null;
      connectionStatus: string;
      locked: boolean;
      cooldownRemainingMs: number;
      activeChunkCount: number;
      rateLimitedChunkCount: number;
      ambiguousChunkCount: number;
    }>;
  } | null>(null);
  const [workerBusy, setWorkerBusy] = useState(false);
  const [concurrencyInput, setConcurrencyInput] = useState("5");

  const loadPipelineStatus = useCallback(async () => {
    try {
      const res = await apiRequest<NonNullable<typeof pipelineStatus>>("/owner/operations/pipelines");
      setPipelineStatus(res);
      if (res.workerControl?.permittedConcurrency) {
        setConcurrencyInput(String(res.workerControl.permittedConcurrency));
      }
    } catch {
      // Non-fatal if Redis/pipelines temporarily unavailable
    }
  }, []);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : "";
      const [res] = await Promise.all([
        apiRequest<{ orders: OrderSummary[] }>(`/owner/orders${qs}`),
        loadPipelineStatus(),
      ]);
      setOrders(res.orders ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load orders.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, loadPipelineStatus]);

  const resolveRecipientUsername = useCallback(async (username: string) => {
    const clean = username.replace(/^@/, "").trim();
    if (!clean) return;
    setResolvingRecipient(true);
    setRecipientResolutionError(null);
    try {
      const res = await apiRequest<{
        resolved: boolean;
        player: ResolvedRecipientMeta | null;
      }>(`/owner/inventory/resolve-player?username=${encodeURIComponent(clean)}`);
      if (res.resolved && res.player) {
        setResolvedRecipient(res.player);
      } else {
        setResolvedRecipient(null);
        setRecipientResolutionError(`Could not resolve @${clean} on LagosLife.`);
      }
    } catch (err) {
      setRecipientResolutionError(
        err instanceof Error ? err.message : "Recipient lookup failed."
      );
    } finally {
      setResolvingRecipient(false);
    }
  }, []);

  const loadOrderDetail = useCallback(
    async (orderId: string) => {
      setDetailLoading(true);
      setConfirmAuthorizeOpen(false);
      setConfirmExecuteJobId(null);
      setConfirmCancelJobId(null);
      try {
        const [orderRes, disbRes, invRes] = await Promise.all([
          apiRequest<{ order: OrderOperationalDetail }>(`/owner/orders/${orderId}`),
          apiRequest<{ disbursementEnabled: boolean; jobs: DisbursementJobView[] }>(
            `/owner/orders/${orderId}/disbursements`
          ).catch(() => ({ disbursementEnabled: false, jobs: [] })),
          apiRequest<{ slots: InventorySlotOption[] }>("/owner/inventory").catch(() => ({
            slots: [],
          })),
        ]);

        const jobs = disbRes.jobs ?? orderRes.order.disbursementJobs ?? [];
        const mergedOrder: OrderOperationalDetail = {
          ...orderRes.order,
          disbursementJobs: jobs,
        };
        setDetail(mergedOrder);
        setDisbursementEnabled(Boolean(disbRes.disbursementEnabled));

        const sortedSlots = [...(invRes.slots ?? [])].sort(
          (a, b) => CANONICAL_SLOTS.indexOf(a.slotCode as (typeof CANONICAL_SLOTS)[number]) -
            CANONICAL_SLOTS.indexOf(b.slotCode as (typeof CANONICAL_SLOTS)[number])
        );
        setInventorySlots(sortedSlots);

        // Extract resolved recipient from existing job chunk if available, or trigger live lookup
        const firstChunkWithTarget = jobs[0]?.chunks?.find((c) => c.resolvedTargetId);
        if (firstChunkWithTarget?.resolvedTargetId) {
          setResolvedRecipient({
            id: firstChunkWithTarget.resolvedTargetId,
            username: firstChunkWithTarget.recipientUsername,
            name: null,
          });
          setRecipientResolutionError(null);
        } else if (mergedOrder.recipientLagoslifeUsername) {
          void resolveRecipientUsername(mergedOrder.recipientLagoslifeUsername);
        }

        // Pre-populate account split allocations from active reservations
        const defaultSelected = makeEmptySlotFlags();
        const defaultSplits = makeEmptySlotStrings();

        for (const resv of mergedOrder.reservations ?? []) {
          if (resv.status === "ACTIVE" && resv.slotCode) {
            const amtBig = parseBigIntSafe(resv.amount);
            const billions = amtBig / ONE_BILLION;
            if (billions > 0n) {
              defaultSelected[resv.slotCode] = true;
              defaultSplits[resv.slotCode] = billions.toString();
            }
          }
        }
        setSelectedSlots(defaultSelected);
        setSplitBillionsBySlot(defaultSplits);

        if (sortedSlots[0]?.id && !manualAccountId) {
          setManualAccountId(sortedSlots[0].id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load order detail.");
      } finally {
        setDetailLoading(false);
      }
    },
    [manualAccountId, resolveRecipientUsername]
  );

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  useEffect(() => {
    if (selectedOrderId) {
      void loadOrderDetail(selectedOrderId);
    } else {
      setDetail(null);
      setResolvedRecipient(null);
    }
  }, [selectedOrderId, loadOrderDetail]);

  // Compute per-slot constraints & allocation totals for the 5 accounts
  const allocationAnalysis = useMemo(() => {
    if (!detail) {
      return {
        remainingOrderUnits: 0n,
        totalAllocatedUnits: 0n,
        unallocatedUnits: 0n,
        totalChunks: 0,
        rows: [],
        validationErrors: [] as string[],
      };
    }

    const reqUnits = parseBigIntSafe(detail.gameAmountRequested);
    const fulUnits = parseBigIntSafe(detail.fulfilledAmount);
    const remainingOrderUnits = reqUnits > fulUnits ? reqUnits - fulUnits : 0n;

    let totalAllocatedUnits = 0n;
    let totalChunks = 0;
    const validationErrors: string[] = [];

    const rows = CANONICAL_SLOTS.map((slotCode) => {
      const slotInfo = inventorySlots.find((s) => s.slotCode === slotCode);
      const isSelected = Boolean(selectedSlots[slotCode]);
      const rawBillions = isSelected ? (splitBillionsBySlot[slotCode] ?? "").trim() : "";
      const parsedBillions = rawBillions ? Number(rawBillions) : 0;
      const allocatedUnits =
        isSelected && Number.isFinite(parsedBillions) && parsedBillions > 0
          ? BigInt(Math.round(parsedBillions)) * ONE_BILLION
          : 0n;

      const observedUnits = parseBigIntSafe(slotInfo?.observedBalance);
      const totalReservedOnSlot = parseBigIntSafe(slotInfo?.reservedForOrders);
      const reservedForThisOrder = (detail.reservations ?? [])
        .filter((r) => r.slotCode === slotCode && r.status === "ACTIVE")
        .reduce((sum, r) => sum + parseBigIntSafe(r.amount), 0n);

      const reservedForOtherOrders =
        totalReservedOnSlot > reservedForThisOrder
          ? totalReservedOnSlot - reservedForThisOrder
          : 0n;
      const maxSpendableForOrder =
        observedUnits > reservedForOtherOrders ? observedUnits - reservedForOtherOrders : 0n;

      const connectionStatus =
        slotInfo?.connectionStatus ??
        (slotInfo?.sessionConnected ? "CONNECTED" : "DISCONNECTED");
      const chunkCount = computeChunkCount(allocatedUnits);

      let slotError: string | null = null;
      if (isSelected) {
        if (allocatedUnits <= 0n) {
          slotError = `Enter a positive amount in Billions for ${slotCode}.`;
        } else if (connectionStatus !== "CONNECTED") {
          slotError = `${slotCode} is ${connectionStatus}. Connect/reconnect session on /owner/inventory first.`;
        } else if (slotInfo && allocatedUnits > maxSpendableForOrder) {
          slotError = `${slotCode} allocation (${formatBillionsOrTrillions(allocatedUnits)}) exceeds available spendable inventory (${formatBillionsOrTrillions(maxSpendableForOrder)}).`;
        }
      }

      if (slotError) {
        validationErrors.push(slotError);
      }

      totalAllocatedUnits += allocatedUnits;
      totalChunks += chunkCount;

      return {
        slotCode,
        label: SLOT_LABELS[slotCode] ?? slotCode,
        slotInfo,
        connectionStatus,
        isSelected,
        rawBillions,
        allocatedUnits,
        chunkCount,
        observedUnits,
        totalReservedOnSlot,
        reservedForThisOrder,
        maxSpendableForOrder,
        slotError,
      };
    });

    if (totalAllocatedUnits > remainingOrderUnits) {
      validationErrors.push(
        `Total allocation (${formatBillionsOrTrillions(totalAllocatedUnits)}) exceeds remaining order amount (${formatBillionsOrTrillions(remainingOrderUnits)}).`
      );
    }

    const unallocatedUnits =
      remainingOrderUnits > totalAllocatedUnits
        ? remainingOrderUnits - totalAllocatedUnits
        : 0n;

    return {
      remainingOrderUnits,
      totalAllocatedUnits,
      unallocatedUnits,
      totalChunks,
      rows,
      validationErrors,
    };
  }, [detail, inventorySlots, selectedSlots, splitBillionsBySlot]);

  const splitEvenlyAcrossSlots = (slotSelection: Record<string, boolean>) => {
    const selectedRows = allocationAnalysis.rows.filter(
      (r) => slotSelection[r.slotCode] && r.maxSpendableForOrder > 0n
    );
    if (selectedRows.length === 0) return;

    const totalRemainingB = allocationAnalysis.remainingOrderUnits / ONE_BILLION;
    let remainingB = totalRemainingB;
    const allocatedBBySlot = new Map<string, bigint>();
    for (const r of selectedRows) allocatedBBySlot.set(r.slotCode, 0n);

    // Water-fill evenly across selected accounts up to each account's maxSpendableForOrder
    let active = [...selectedRows];
    while (remainingB > 0n && active.length > 0) {
      const share = remainingB / BigInt(active.length);
      const step = share > 0n ? share : 1n;
      let progressed = false;
      const nextActive: typeof active = [];
      for (const r of active) {
        if (remainingB <= 0n) break;
        const maxB = r.maxSpendableForOrder / ONE_BILLION;
        const curB = allocatedBBySlot.get(r.slotCode) ?? 0n;
        const roomB = maxB > curB ? maxB - curB : 0n;
        const takeB = roomB >= step ? step : roomB;
        const actualTake = takeB > remainingB ? remainingB : takeB;
        if (actualTake > 0n) {
          allocatedBBySlot.set(r.slotCode, curB + actualTake);
          remainingB -= actualTake;
          progressed = true;
        }
        if (roomB > actualTake) {
          nextActive.push(r);
        }
      }
      if (!progressed) break;
      active = nextActive;
    }

    setSplitBillionsBySlot((prev) => {
      const next = { ...prev };
      for (const r of allocationAnalysis.rows) {
        if (slotSelection[r.slotCode]) {
          const b = allocatedBBySlot.get(r.slotCode) ?? 0n;
          next[r.slotCode] = b > 0n ? b.toString() : "";
        } else {
          next[r.slotCode] = "";
        }
      }
      return next;
    });
  };

  const handleToggleSlot = (slotCode: string, checked: boolean) => {
    const nextSelected = { ...selectedSlots, [slotCode]: checked };
    setSelectedSlots(nextSelected);
    if (checked) {
      if (allocationAnalysis.unallocatedUnits === 0n) {
        // Rebalance evenly across all checked slots so newly checked accounts actually receive chunks
        splitEvenlyAcrossSlots(nextSelected);
      } else if (!splitBillionsBySlot[slotCode]) {
        const row = allocationAnalysis.rows.find((r) => r.slotCode === slotCode);
        const rem = allocationAnalysis.unallocatedUnits;
        const cap =
          row && row.maxSpendableForOrder > 0n && row.maxSpendableForOrder < rem
            ? row.maxSpendableForOrder
            : rem;
        const defaultB = cap / ONE_BILLION;
        if (defaultB > 0n) {
          setSplitBillionsBySlot((prev) => ({ ...prev, [slotCode]: defaultB.toString() }));
        }
      }
    }
    setConfirmAuthorizeOpen(false);
  };

  const handleFillRemainingOnSlot = (slotCode: string) => {
    const row = allocationAnalysis.rows.find((r) => r.slotCode === slotCode);
    const otherAllocated = allocationAnalysis.totalAllocatedUnits - (row?.allocatedUnits ?? 0n);
    const needed =
      allocationAnalysis.remainingOrderUnits > otherAllocated
        ? allocationAnalysis.remainingOrderUnits - otherAllocated
        : 0n;
    const cap =
      row && row.maxSpendableForOrder > 0n && row.maxSpendableForOrder < needed
        ? row.maxSpendableForOrder
        : needed;
    const b = cap / ONE_BILLION;
    setSelectedSlots((prev) => ({ ...prev, [slotCode]: b > 0n }));
    setSplitBillionsBySlot((prev) => ({ ...prev, [slotCode]: b > 0n ? b.toString() : "" }));
    setConfirmAuthorizeOpen(false);
  };

  const handleRunExpirySweep = async () => {
    setError(null);
    setActionBanner(null);
    try {
      const res = await apiRequest<{ expiredCount: number }>("/owner/orders/expire-sweep", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setActionBanner(`Expiry sweep completed. Released ${res.expiredCount} expired order(s).`);
      await loadOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run expiry sweep.");
    }
  };

  const handleConfirmPaymentAndDeliver = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmDeliverOrder) return;
    const ref = confirmRefInput.trim();
    if (ref.length < 3) {
      setError("Enter a valid OPay / bank transaction reference (at least 3 characters).");
      return;
    }
    setConfirmBusy(true);
    setError(null);
    setActionBanner(null);
    try {
      const res = await apiRequest<{
        idempotent: boolean;
        orderStatus: string;
        job?: { id: string; totalChunks: number } | null;
      }>(`/owner/orders/${confirmDeliverOrder.id}/confirm-and-deliver`, {
        method: "POST",
        body: JSON.stringify({
          bankCreditReference: ref,
        }),
      });
      setActionBanner(
        res.job
          ? `Payment confirmed for ${confirmDeliverOrder.orderNumber} and delivery queued (${res.job.totalChunks} chunk(s)).`
          : `Payment confirmed for ${confirmDeliverOrder.orderNumber} (status: ${res.orderStatus}).`
      );
      const targetId = confirmDeliverOrder.id;
      setConfirmDeliverOrder(null);
      setConfirmRefInput("");
      await loadOrders();
      if (selectedOrderId === targetId) {
        await loadOrderDetail(targetId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to confirm payment and start delivery.");
    } finally {
      setConfirmBusy(false);
    }
  };

  const handleAuthorizeDisbursement = async () => {
    if (!detail) return;
    setDisbBusy(true);
    setError(null);
    setActionBanner(null);
    try {
      const allocations = allocationAnalysis.rows
        .filter((r) => r.isSelected && r.allocatedUnits > 0n)
        .map((r) => ({
          slotCode: r.slotCode,
          amount: r.allocatedUnits.toString(),
        }));

      const res = await apiRequest<{ job: DisbursementJobView }>(
        `/owner/orders/${detail.id}/disbursements/authorize`,
        {
          method: "POST",
          body: JSON.stringify({
            allocations,
            authorizationNote: authNote.trim() || undefined,
          }),
        }
      );

      setConfirmAuthorizeOpen(false);
      setActionBanner(
        `Authorized Disbursement Job #${res.job.id.slice(0, 8)} (${res.job.totalChunks} chunk(s) of <= 100B across ${allocations.length} account(s)).`
      );
      setAuthNote("");
      await loadOrderDetail(detail.id);
      await loadOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to authorize disbursement job.");
    } finally {
      setDisbBusy(false);
    }
  };


  const handleJobAction = async (
    jobId: string,
    action: "execute" | "pause" | "resume" | "cancel",
    reason?: string
  ) => {
    if (!detail) return;
    setDisbBusy(true);
    setError(null);
    setActionBanner(null);
    try {
      const twoFactorVal = action === "resume" ? (twoFactorByJob[jobId] ?? "").trim() : "";
      const body =
        action === "execute"
          ? { maxChunksToProcess: 5, waitForCooldown: false }
          : {
              reason: reason || `Owner ${action} command.`,
              ...(twoFactorVal ? { twoFactorCode: twoFactorVal } : {}),
            };
      await apiRequest(`/owner/disbursements/${jobId}/${action}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (twoFactorVal) {
        setTwoFactorByJob((prev) => ({ ...prev, [jobId]: "" }));
      }
      setConfirmExecuteJobId(null);
      setConfirmCancelJobId(null);
      setCancelJobReason("");
      setActionBanner(`Disbursement job ${action.toUpperCase()} completed.`);
      await loadOrderDetail(detail.id);
      await loadOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} disbursement job.`);
    } finally {
      setDisbBusy(false);
    }
  };


  const handleResolveAmbiguousChunk = async (
    jobId: string,
    chunkId: string,
    outcome: "CONFIRMED_DELIVERED" | "CONFIRMED_NOT_DELIVERED"
  ) => {
    if (!detail) return;
    const notes = (ambiguousNotesByChunk[chunkId] ?? "").trim();
    if (notes.length < 3) {
      setError(
        "Please enter reconciliation notes (at least 3 characters) before resolving an ambiguous chunk."
      );
      return;
    }
    setDisbBusy(true);
    setError(null);
    setActionBanner(null);
    try {
      await apiRequest(`/owner/disbursements/${jobId}/chunks/${chunkId}/resolve`, {
        method: "POST",
        body: JSON.stringify({ outcome, notes }),
      });
      setActionBanner(`Ambiguous chunk #${chunkId.slice(0, 8)} resolved as ${outcome}.`);
      await loadOrderDetail(detail.id);
      await loadOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve ambiguous chunk.");
    } finally {
      setDisbBusy(false);
    }
  };


  const handleManualFulfilment = async () => {
    if (!detail || !manualAccountId || !manualAmountBillions || !manualExternalRef) return;
    setDisbBusy(true);
    setError(null);
    setActionBanner(null);
    try {
      const deliveredUnits = BigInt(Math.round(Number(manualAmountBillions))) * ONE_BILLION;
      await apiRequest(`/owner/orders/${detail.id}/confirm-fulfilment`, {
        method: "POST",
        body: JSON.stringify({
          sourceGameAccountId: manualAccountId,
          deliveredAmount: deliveredUnits.toString(),
          externalReference: manualExternalRef.trim(),
          idempotencyKey: `man_${detail.id}_${manualExternalRef.trim()}`,
          notes: manualNotes.trim() || undefined,
        }),
      });
      setActionBanner("Manual fulfilment delivery recorded.");
      setManualAmountBillions("");
      setManualExternalRef("");
      setManualNotes("");
      await loadOrderDetail(detail.id);
      await loadOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to confirm manual fulfilment.");
    } finally {
      setDisbBusy(false);
    }
  };


  const handleRequestRefund = async () => {
    if (!detail || !refundAmountNaira || !refundReason) return;
    setDisbBusy(true);
    setError(null);
    setActionBanner(null);
    try {
      const kobo = BigInt(Math.round(Number(refundAmountNaira) * 100));
      await apiRequest(`/owner/orders/${detail.id}/refunds`, {
        method: "POST",
        body: JSON.stringify({
          scope: refundScope,
          requestedAmountKobo: kobo.toString(),
          reason: refundReason.trim(),
        }),
      });
      setActionBanner("Refund request recorded.");
      setRefundAmountNaira("");
      setRefundReason("");
      await loadOrderDetail(detail.id);
      await loadOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create refund request.");
    } finally {
      setDisbBusy(false);
    }
  };


  const handleWorkerControl = async (
    action: "PAUSE_INTAKE" | "RESUME_INTAKE" | "SET_CONCURRENCY",
    permittedConcurrency?: number
  ) => {
    setWorkerBusy(true);
    setError(null);
    setActionBanner(null);
    try {
      const res = await apiRequest<{
        appliedNote: string;
      }>("/owner/worker/control", {
        method: "POST",
        body: JSON.stringify({
          action,
          ...(permittedConcurrency ? { permittedConcurrency } : {}),
          reason: `Owner ${action.toLowerCase()} via dashboard`,
        }),
      });
      setActionBanner(res.appliedNote);
      await loadPipelineStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update worker control.");
    } finally {
      setWorkerBusy(false);
    }
  };

  const handleCreateDirectOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    const numericT = Number(directAmountT);
    if (!directRecipient.trim() || !Number.isFinite(numericT) || numericT <= 0) {
      setError("Enter a valid recipient LagosLife username and positive amount in T.");
      return;
    }
    setDirectBusy(true);
    setError(null);
    setActionBanner(null);
    try {
      const scaledUnits = BigInt(Math.round(numericT * 1000)) * (ONE_TRILLION / BigInt(1000));
      const res = await apiRequest<{ order: { id: string; orderNumber: string } }>("/owner/orders", {
        method: "POST",
        body: JSON.stringify({
          orderType: "BULK",
          gameAmount: scaledUnits.toString(),
          recipientLagoslifeUsername: directRecipient.trim(),
          markPrePaid: directPrePaid,
          reason: directReason.trim() || "Pre-paid direct owner send",
        }),
      });
      setDirectOpen(false);
      setDirectRecipient("");
      setDirectReason("");
      setActionBanner(
        `Created order ${res.order.orderNumber}${directPrePaid ? " (marked Ready for Fulfilment)" : ""}.`
      );
      await loadOrders();
      await loadOrderDetail(res.order.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create direct order.");
    } finally {
      setDirectBusy(false);
    }
  };

  return (
    <OwnerShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-[#0B1324]">
              All Orders &amp; Multi-Account Disbursement Desk
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Authorize single or split fulfilment across all 5 LagosLife accounts (100B max chunks, 30.5s per-account cooldown), monitor live chunk delivery, and resolve exceptions.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="owner" onClick={() => setDirectOpen(true)}>
              Direct / Pre-Paid Send
            </Button>
            <Button variant="secondary" onClick={handleRunExpirySweep}>
              Run Expiry Sweep
            </Button>
            <Link href="/owner/verification">
              <Button>Verification Desk</Button>
            </Link>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {actionBanner && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {actionBanner}
          </div>
        )}

        {pipelineStatus && (
          <Card
            title="Worker & Multi-Pipeline Control"
            action={
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge
                  label={pipelineStatus.workerHeartbeat.alive ? "Worker Online" : "Worker Offline"}
                  tone={pipelineStatus.workerHeartbeat.alive ? "success" : "danger"}
                />
                <StatusBadge
                  label={
                    pipelineStatus.workerControl.intakePaused ? "Intake Paused" : "Intake Active"
                  }
                  tone={pipelineStatus.workerControl.intakePaused ? "warning" : "info"}
                />
                <Button size="sm" variant="secondary" onClick={loadPipelineStatus}>
                  Refresh
                </Button>
              </div>
            }
          >
            <div className="space-y-3 text-xs">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                  <div className="text-[10px] font-semibold uppercase text-slate-500">
                    Last Heartbeat
                  </div>
                  <div className="mt-0.5 font-mono-tabular font-semibold text-slate-900">
                    {pipelineStatus.workerHeartbeat.lastHeartbeatAt
                      ? formatDateTime(pipelineStatus.workerHeartbeat.lastHeartbeatAt)
                      : "None"}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                  <div className="text-[10px] font-semibold uppercase text-slate-500">
                    Transfer Mode
                  </div>
                  <div className="mt-0.5 font-semibold text-slate-900">
                    {pipelineStatus.workerHeartbeat.disbursementEnabled === true
                      ? "LIVE TRANSFERS ENABLED"
                      : "SAFE MODE (DISBURSEMENT_ENABLED=false)"}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                  <div className="text-[10px] font-semibold uppercase text-slate-500">
                    BullMQ Queue
                  </div>
                  <div className="mt-0.5 font-mono-tabular font-semibold text-slate-900">
                    W:{pipelineStatus.queueStats.waiting} · A:{pipelineStatus.queueStats.active} · D:
                    {pipelineStatus.queueStats.delayed} · F:{pipelineStatus.queueStats.failed} · C:
                    {pipelineStatus.queueStats.completed}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                  <div className="text-[10px] font-semibold uppercase text-slate-500">
                    Permitted Concurrency
                  </div>
                  <div className="mt-0.5 font-mono-tabular font-semibold text-slate-900">
                    {pipelineStatus.workerControl.permittedConcurrency} / 5 pipelines
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  {pipelineStatus.workerControl.intakePaused ? (
                    <Button
                      size="sm"
                      variant="owner"
                      disabled={workerBusy}
                      onClick={() => handleWorkerControl("RESUME_INTAKE")}
                    >
                      Resume Job Intake
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={workerBusy}
                      onClick={() => handleWorkerControl("PAUSE_INTAKE")}
                    >
                      Pause Job Intake
                    </Button>
                  )}
                  <div className="flex items-center gap-1.5">
                    <label className="text-slate-600">Concurrency:</label>
                    <select
                      className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-mono-tabular"
                      value={concurrencyInput}
                      onChange={(e) => setConcurrencyInput(e.target.value)}
                    >
                      {[1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={workerBusy}
                      onClick={() =>
                        handleWorkerControl("SET_CONCURRENCY", Number(concurrencyInput))
                      }
                    >
                      Apply
                    </Button>
                  </div>
                </div>
                <p className="text-[11px] text-slate-500">
                  {pipelineStatus.workerHeartbeat.alive
                    ? "Windows worker is connected; intake pause and concurrency updates apply within 15s."
                    : "Worker is offline. The website cannot remotely start a stopped Windows process; run `node --env-file=.env.worker apps/api/dist/worker.js` on your Windows PC."}
                </p>
              </div>

              <div className="grid gap-2 sm:grid-cols-5">
                {pipelineStatus.accounts.map((acc) => (
                  <div
                    key={acc.id}
                    className="rounded-lg border border-slate-200 bg-white p-2 text-[11px]"
                  >
                    <div className="font-semibold text-slate-900">{acc.slotCode}</div>
                    <div className="text-slate-500">
                      {acc.lagoslifeUsername ? `@${acc.lagoslifeUsername}` : "Unconfigured"}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <span
                        className={`rounded px-1 py-0.5 font-semibold ${
                          acc.locked
                            ? "bg-amber-100 text-amber-800"
                            : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {acc.locked ? "LOCKED" : "Free"}
                      </span>
                      {acc.cooldownRemainingMs > 0 && (
                        <span className="rounded bg-indigo-100 px-1 py-0.5 font-semibold text-indigo-800">
                          {Math.ceil(acc.cooldownRemainingMs / 1000)}s
                        </span>
                      )}
                      {acc.ambiguousChunkCount > 0 && (
                        <span className="rounded bg-rose-100 px-1 py-0.5 font-semibold text-rose-800">
                          {acc.ambiguousChunkCount} ambig
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        )}

        <div className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((f) => {
            const active = statusFilter === f.value;
            return (
              <button
                key={f.label}
                type="button"
                onClick={() => setStatusFilter(f.value)}
                className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                  active
                    ? "border border-[#0B1324] bg-[#0B1324] text-white"
                    : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        <Card>
          {loading ? (
            <div className="space-y-3 py-2">
              <SkeletonCard />
              <SkeletonCard />
            </div>
          ) : orders.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 py-10 px-6 text-center">
              <p className="font-display text-sm font-semibold text-[#0B1324]">
                No orders match this filter
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Try selecting a different status filter above.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                    <th className="py-3 pr-4">Order</th>
                    <th className="py-3 pr-4">Customer / Recipient</th>
                    <th className="py-3 pr-4">Delivered / Requested</th>
                    <th className="py-3 pr-4">Fiat (NGN)</th>
                    <th className="py-3 pr-4">Status</th>
                    <th className="py-3 pr-4">Created</th>
                    <th className="py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {orders.map((o) => {
                    const reqBig = parseBigIntSafe(o.gameAmountRequested);
                    const fulBig = parseBigIntSafe(o.fulfilledAmount);
                    const pct =
                      reqBig > 0n ? Math.min(100, Number((fulBig * 100n) / reqBig)) : 0;

                    return (
                      <tr key={o.id} className="hover:bg-slate-50">
                        <td className="py-3 pr-4 font-medium text-slate-900">
                          <div>{o.orderNumber}</div>
                          <div className="text-xs text-slate-500">{o.channel}</div>
                        </td>
                        <td className="py-3 pr-4">
                          <div className="font-medium text-slate-800">
                            {o.customer?.fullName ?? "Customer"}
                          </div>
                          <div className="text-xs font-medium text-indigo-600">
                            @{o.recipientLagoslifeUsername}
                          </div>
                        </td>
                        <td className="py-3 pr-4">
                          <div className="font-medium text-slate-900 tabular-nums">
                            {formatBillionsOrTrillions(o.fulfilledAmount)} /{" "}
                            {formatBillionsOrTrillions(o.gameAmountRequested)}
                          </div>
                          <div className="mt-1 h-1.5 w-28 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className="h-full bg-emerald-600 transition-all"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </td>
                        <td className="py-3 pr-4">
                          <div className="font-medium text-slate-900 tabular-nums">
                            {formatNaira(o.fiatAmountKobo)}
                          </div>
                          <div className="text-xs text-slate-500 tabular-nums">
                            Verified: {formatNaira(o.verifiedGrossFiatKobo)}
                          </div>
                        </td>
                        <td className="py-3 pr-4">
                          <StatusBadge label={o.status} tone={getBadgeTone(o.status)} />
                        </td>
                        <td className="py-3 pr-4 text-xs text-slate-500">
                          {formatDateTime(o.createdAt)}
                        </td>
                        <td className="py-3 text-right">
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            {(o.status === "AWAITING_PAYMENT" ||
                              o.status === "PAYMENT_SUBMITTED" ||
                              o.status === "PAYMENT_EXCEPTION_REVIEW") && (
                              <Button
                                variant="owner"
                                onClick={() => {
                                  setConfirmDeliverOrder(o);
                                  setConfirmRefInput("");
                                }}
                              >
                                Confirm Payment &amp; Start Delivery
                              </Button>
                            )}
                            <Button
                              variant="secondary"
                              onClick={() => setSelectedOrderId(o.id)}
                            >
                              Manage &amp; Disburse
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {confirmDeliverOrder && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
            <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl space-y-4">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Confirm Payment &amp; Start Delivery
                </h3>
                <p className="mt-1 text-xs text-slate-600">
                  Verify OPay/bank receipt for{" "}
                  <strong>{confirmDeliverOrder.orderNumber}</strong> (@
                  {confirmDeliverOrder.recipientLagoslifeUsername}) —{" "}
                  <strong>{formatNaira(confirmDeliverOrder.fiatAmountKobo)}</strong>.
                </p>
              </div>
              <form onSubmit={handleConfirmPaymentAndDeliver} className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    OPay / Bank Transaction Reference
                  </label>
                  <input
                    type="text"
                    required
                    minLength={3}
                    autoFocus
                    placeholder="e.g. OPAY-20261116-98421"
                    value={confirmRefInput}
                    onChange={(e) => setConfirmRefInput(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono-tabular"
                  />
                </div>
                <div className="flex items-center justify-end gap-2 pt-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setConfirmDeliverOrder(null)}
                    disabled={confirmBusy}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" variant="owner" disabled={confirmBusy}>
                    {confirmBusy ? "Confirming & Queuing…" : "Confirm & Start Delivery"}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}

        <SlideOver
          open={Boolean(selectedOrderId)}
          onClose={() => setSelectedOrderId(null)}
          title={detail ? `Order ${detail.orderNumber}` : "Order Operational Detail"}
          subtitle="Verify recipient identity, allocate across the 5 LagosLife accounts, authorize 100B chunk disbursement, and monitor live delivery."
        >
          {detailLoading || !detail ? (
            <p className="py-8 text-sm text-slate-500">
              Loading operational &amp; disbursement details...
            </p>
          ) : (
            <div className="space-y-6">
              {/* 1. Order, Recipient Identity, Payment Verification & Fulfilment Status */}
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2.5">
                  <div>
                    <span className="text-xs font-semibold uppercase text-slate-500">
                      Fulfilment &amp; Order Status
                    </span>
                    <div className="mt-1 flex items-center gap-2">
                      <StatusBadge label={detail.status} tone={getBadgeTone(detail.status)} />
                      <span className="text-xs text-slate-500">
                        Ref: <strong className="font-mono">{detail.paymentReference}</strong>
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-xs font-semibold uppercase text-slate-500">
                      Payment Verification
                    </span>
                    <div className="mt-1">
                      <StatusBadge
                        label={
                          parseBigIntSafe(detail.verifiedGrossFiatKobo) >=
                            parseBigIntSafe(detail.fiatAmountKobo) &&
                          parseBigIntSafe(detail.fiatAmountKobo) > 0n
                            ? "PAYMENT_VERIFIED"
                            : detail.paymentExceptionType && detail.paymentExceptionType !== "NONE"
                              ? detail.paymentExceptionType
                              : "UNVERIFIED"
                        }
                        tone={
                          parseBigIntSafe(detail.verifiedGrossFiatKobo) >=
                            parseBigIntSafe(detail.fiatAmountKobo) &&
                          parseBigIntSafe(detail.fiatAmountKobo) > 0n
                            ? "success"
                            : "warning"
                        }
                      />
                    </div>
                  </div>
                </div>

                {/* Recipient LagosLife Identity Card */}
                <div className="rounded-lg border border-indigo-100 bg-white p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-[11px] font-semibold uppercase text-slate-500">
                        Customer LagosLife Recipient
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <span className="text-sm font-bold text-indigo-700">
                          @{detail.recipientLagoslifeUsername}
                        </span>
                        {resolvedRecipient ? (
                          <span className="rounded-md bg-emerald-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
                            ID: {resolvedRecipient.id}
                            {resolvedRecipient.name ? ` (${resolvedRecipient.name})` : ""}
                          </span>
                        ) : resolvingRecipient ? (
                          <span className="text-xs text-slate-400">Resolving player ID...</span>
                        ) : (
                          <span className="rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                            {recipientResolutionError ?? "Player ID not yet resolved"}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={resolvingRecipient}
                      onClick={() => resolveRecipientUsername(detail.recipientLagoslifeUsername)}
                      className="rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                    >
                      {resolvingRecipient ? "Checking..." : "Verify Recipient ID"}
                    </button>
                  </div>
                </div>

                {/* Requested / Delivered / Remaining / Fiat Summary */}
                <div className="grid grid-cols-2 gap-3 pt-1 text-sm">
                  <div className="rounded-lg border border-slate-200 bg-white p-2.5">
                    <div className="text-[11px] text-slate-500">Requested Currency</div>
                    <div className="mt-0.5 font-bold text-slate-900 tabular-nums">
                      {formatBillionsOrTrillions(detail.gameAmountRequested)}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-white p-2.5">
                    <div className="text-[11px] text-slate-500">Delivered Currency</div>
                    <div className="mt-0.5 font-bold text-emerald-700 tabular-nums">
                      {formatBillionsOrTrillions(detail.fulfilledAmount)}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-white p-2.5">
                    <div className="text-[11px] text-slate-500">Remaining to Deliver</div>
                    <div className="mt-0.5 font-bold text-amber-700 tabular-nums">
                      {formatBillionsOrTrillions(allocationAnalysis.remainingOrderUnits)}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-white p-2.5">
                    <div className="text-[11px] text-slate-500">Verified / Total Fiat</div>
                    <div className="mt-0.5 font-bold text-slate-900 tabular-nums">
                      {formatNaira(detail.verifiedGrossFiatKobo)} /{" "}
                      {formatNaira(detail.fiatAmountKobo)}
                    </div>
                  </div>
                </div>
              </div>

              {/* 2. STAGE 8C: FIVE-ACCOUNT ALLOCATION & DISBURSEMENT ENGINE */}
              <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">
                      LagosLife 5-Account Disbursement Engine
                    </h3>
                    <p className="text-xs text-slate-600">
                      Arrangement A: All 5 accounts eligible · Max chunk: 100B · Cooldown: 30.5s/account
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      disbursementEnabled
                        ? "bg-emerald-100 text-emerald-800"
                        : "bg-amber-100 text-amber-800"
                    }`}
                  >
                    {disbursementEnabled
                      ? "LIVE EXECUTION ENABLED"
                      : "DISBURSEMENT_ENABLED=false (SAFE MODE)"}
                  </span>
                </div>

                {/* Account Allocation Builder (shown when order has remaining unfulfilled amount) */}
                {allocationAnalysis.remainingOrderUnits > 0n &&
                  (detail.status === "READY_FOR_FULFILMENT" ||
                    detail.status === "PARTIALLY_FULFILLED" ||
                    detail.status === "QUEUED") && (
                    <div className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-xs font-bold text-slate-900">
                            Select Fulfilment Accounts &amp; Allocate Amounts (in Billions, 1,000B = 1T)
                          </div>
                          <div className="text-[11px] text-slate-500">
                            Select any single account or split across multiple accounts. Allocations exceeding available inventory are blocked.
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => {
                              const anyChecked = Object.values(selectedSlots).some(Boolean);
                              if (anyChecked) {
                                splitEvenlyAcrossSlots(selectedSlots);
                              } else {
                                const auto: Record<string, boolean> = {};
                                for (const r of allocationAnalysis.rows) {
                                  if (r.slotCode !== "MAIN_TREASURY" && r.maxSpendableForOrder > 0n) {
                                    auto[r.slotCode] = true;
                                  }
                                }
                                setSelectedSlots(auto);
                                splitEvenlyAcrossSlots(auto);
                              }
                              setConfirmAuthorizeOpen(false);
                            }}
                            className="text-[11px] font-semibold text-emerald-700 hover:text-emerald-900"
                          >
                            Split Evenly
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedSlots(makeEmptySlotFlags());
                              setSplitBillionsBySlot(makeEmptySlotStrings());
                              setConfirmAuthorizeOpen(false);
                            }}
                            className="text-[11px] font-semibold text-slate-500 hover:text-slate-800"
                          >
                            Clear Split
                          </button>
                        </div>
                      </div>

                      {/* 5 Account Selection Rows */}
                      <div className="space-y-2">
                        {allocationAnalysis.rows.map((row) => (
                          <div
                            key={row.slotCode}
                            className={`rounded-lg border p-2.5 text-xs transition ${
                              row.slotError
                                ? "border-rose-300 bg-rose-50/60"
                                : row.isSelected
                                  ? "border-indigo-300 bg-indigo-50/40"
                                  : "border-slate-200 bg-slate-50"
                            }`}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <label className="flex cursor-pointer items-center gap-2 font-semibold text-slate-900">
                                <input
                                  type="checkbox"
                                  checked={row.isSelected}
                                  onChange={(e) =>
                                    handleToggleSlot(row.slotCode, e.target.checked)
                                  }
                                  className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                                />
                                <span>{row.label}</span>
                                {row.slotInfo?.lagoslifeUsername &&
                                  !row.slotInfo.lagoslifeUsername.startsWith("UNCONFIGURED") && (
                                    <span className="text-indigo-600">
                                      @{row.slotInfo.lagoslifeUsername}
                                    </span>
                                  )}
                              </label>
                              <div className="flex items-center gap-1.5">
                                <StatusBadge
                                  label={row.connectionStatus}
                                  tone={getBadgeTone(row.connectionStatus)}
                                />
                                {row.reservedForThisOrder > 0n && (
                                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                                    Reserved Here: {formatBillionsOrTrillions(row.reservedForThisOrder)}
                                  </span>
                                )}
                              </div>
                            </div>

                            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
                              <div className="space-x-3">
                                <span>
                                  Observed:{" "}
                                  <strong className="text-slate-900">
                                    {formatBillionsOrTrillions(row.observedUnits)}
                                  </strong>
                                </span>
                                <span>
                                  Reserved:{" "}
                                  <strong className="text-amber-700">
                                    {formatBillionsOrTrillions(row.totalReservedOnSlot)}
                                  </strong>
                                </span>
                                <span>
                                  Available for Order:{" "}
                                  <strong className="text-emerald-700">
                                    {formatBillionsOrTrillions(row.maxSpendableForOrder)}
                                  </strong>
                                </span>
                              </div>

                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => handleFillRemainingOnSlot(row.slotCode)}
                                  className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-700 hover:bg-slate-100"
                                >
                                  Fill Remaining
                                </button>
                                <input
                                  type="number"
                                  min="0"
                                  step="1"
                                  placeholder="0"
                                  value={splitBillionsBySlot[row.slotCode] ?? ""}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setSelectedSlots((prev) => ({
                                      ...prev,
                                      [row.slotCode]: Number(val) > 0,
                                    }));
                                    setSplitBillionsBySlot((prev) => ({
                                      ...prev,
                                      [row.slotCode]: val,
                                    }));
                                    setConfirmAuthorizeOpen(false);
                                  }}
                                  className="w-24 rounded border border-slate-300 bg-white px-2 py-1 text-right font-mono text-xs"
                                />
                                <span className="font-semibold text-slate-600">B</span>
                                {row.chunkCount > 0 && (
                                  <span className="text-[10px] text-indigo-700">
                                    ({row.chunkCount} chunk{row.chunkCount === 1 ? "" : "s"})
                                  </span>
                                )}
                              </div>
                            </div>

                            {row.slotError && (
                              <div className="mt-1.5 text-[11px] font-medium text-rose-700">
                                {row.slotError}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>

                      {/* Allocation Totals & Constraint Summary */}
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs space-y-1">
                        <div className="flex justify-between">
                          <span className="text-slate-600">Total Selected Allocation:</span>
                          <span className="font-bold text-slate-900 tabular-nums">
                            {formatBillionsOrTrillions(allocationAnalysis.totalAllocatedUnits)} (
                            {allocationAnalysis.totalChunks} chunk
                            {allocationAnalysis.totalChunks === 1 ? "" : "s"} of &le; 100B)
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-600">Remaining Unallocated Order Amount:</span>
                          <span
                            className={`font-bold tabular-nums ${
                              allocationAnalysis.unallocatedUnits === 0n
                                ? "text-emerald-700"
                                : "text-amber-700"
                            }`}
                          >
                            {formatBillionsOrTrillions(allocationAnalysis.unallocatedUnits)}
                          </span>
                        </div>
                      </div>

                      {allocationAnalysis.validationErrors.length > 0 && (
                        <div className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-xs text-rose-700 space-y-1">
                          {allocationAnalysis.validationErrors.map((err, i) => (
                            <div key={i}>&bull; {err}</div>
                          ))}
                        </div>
                      )}

                      <input
                        type="text"
                        placeholder="Authorization note for audit log (optional)"
                        value={authNote}
                        onChange={(e) => setAuthNote(e.target.value)}
                        className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                      />

                      {!confirmAuthorizeOpen ? (
                        <Button
                          onClick={() => setConfirmAuthorizeOpen(true)}
                          disabled={
                            disbBusy ||
                            allocationAnalysis.totalAllocatedUnits <= 0n ||
                            allocationAnalysis.validationErrors.length > 0
                          }
                          className="w-full"
                        >
                          Review &amp; Authorize Disbursement Plan
                        </Button>
                      ) : (
                        <div className="rounded-lg border border-indigo-300 bg-indigo-50 p-3 space-y-2.5 text-xs">
                          <div className="font-bold text-indigo-950">
                            Confirm Owner Disbursement Authorization
                          </div>
                          <p className="text-indigo-900">
                            You are authorizing{" "}
                            <strong>
                              {formatBillionsOrTrillions(allocationAnalysis.totalAllocatedUnits)}
                            </strong>{" "}
                            ({allocationAnalysis.totalChunks} chunk
                            {allocationAnalysis.totalChunks === 1 ? "" : "s"} of &le; 100B) to
                            recipient <strong>@{detail.recipientLagoslifeUsername}</strong>
                            {resolvedRecipient ? ` (Player ID: ${resolvedRecipient.id})` : ""}.
                          </p>
                          <div className="flex gap-2">
                            <Button
                              onClick={handleAuthorizeDisbursement}
                              disabled={disbBusy}
                              className="flex-1"
                            >
                              {disbBusy ? "Authorizing..." : "Confirm & Authorize Job"}
                            </Button>
                            <Button
                              variant="secondary"
                              onClick={() => setConfirmAuthorizeOpen(false)}
                              disabled={disbBusy}
                            >
                              Back
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                {/* 3. TRANSFER PROGRESS & JOB CONTROLS */}
                {(detail.disbursementJobs ?? []).length === 0 ? (
                  <p className="text-xs text-slate-500">
                    No disbursement jobs authorized for this order yet. Payment verification never triggers transfers automatically.
                  </p>
                ) : (
                  <div className="space-y-4">
                    {(detail.disbursementJobs ?? []).map((job) => {
                      const activeOrNextChunk = job.chunks.find(
                        (c) =>
                          c.status === "IN_FLIGHT" ||
                          c.status === "AMBIGUOUS_MANUAL_REVIEW" ||
                          c.status === "PENDING" ||
                          c.status === "FAILED_RETRYABLE"
                      );
                      const succeededChunks = job.chunks.filter((c) => c.status === "SUCCEEDED");
                      const lastSucceededChunk =
                        succeededChunks.length > 0
                          ? succeededChunks[succeededChunks.length - 1]
                          : null;
                      const failedOrAmbiguousChunks = job.chunks.filter(
                        (c) =>
                          c.status === "AMBIGUOUS_MANUAL_REVIEW" ||
                          c.status === "FAILED_RETRYABLE" ||
                          c.status === "FAILED_TERMINAL"
                      );

                      return (
                        <div
                          key={job.id}
                          className="rounded-xl border border-slate-200 bg-white p-4 space-y-3 shadow-xs"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <div className="text-xs font-bold text-slate-900">
                                Disbursement Job #{job.id.slice(0, 8)}
                              </div>
                              <div className="text-[11px] text-slate-500">
                                Created {formatDateTime(job.createdAt)}
                              </div>
                            </div>
                            <StatusBadge label={job.status} tone={getBadgeTone(job.status)} />
                          </div>

                          {/* Obvious Status Alert Banners */}
                          {job.hasAmbiguousChunks && (
                            <div className="rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-xs font-medium text-amber-900">
                              Paused for Owner Manual Review: An uncertain LagosLife response occurred and requires reconciliation below before resuming.
                            </div>
                          )}
                          {!job.hasAmbiguousChunks && job.status === "PAUSED" && (
                            <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs font-medium text-amber-800">
                              Transfer Job is Paused. Click &ldquo;Resume Job&rdquo; when ready to continue sending remaining chunks.
                            </div>
                          )}
                          {job.status === "COMPLETED" && (
                            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2.5 text-xs font-medium text-emerald-800">
                              All {job.totalChunks} transfer chunk(s) confirmed delivered to @{detail.recipientLagoslifeUsername}.
                            </div>
                          )}
                          {job.status === "FAILED" && (
                            <div className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-xs font-medium text-rose-700">
                              Disbursement job halted in FAILED state. Inspect chunk errors below.
                            </div>
                          )}

                          {/* Progress Bar */}
                          <div className="space-y-1">
                            <div className="flex justify-between text-xs font-semibold text-slate-700">
                              <span>
                                Chunks: {job.completedChunks} / {job.totalChunks} Completed
                              </span>
                              <span>{job.progressPercent}%</span>
                            </div>
                            <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
                              <div
                                className={`h-full transition-all ${
                                  job.hasAmbiguousChunks
                                    ? "bg-amber-500"
                                    : job.status === "COMPLETED"
                                      ? "bg-emerald-600"
                                      : "bg-indigo-600"
                                }`}
                                style={{ width: `${job.progressPercent}%` }}
                              />
                            </div>
                          </div>

                          {/* Detailed Transfer Telemetry Grid */}
                          <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-100 bg-slate-50 p-2.5 text-xs">
                            <div>
                              <span className="text-[11px] text-slate-500">Job Delivered / Total</span>
                              <div className="font-bold text-slate-900 tabular-nums">
                                {formatBillionsOrTrillions(job.deliveredAmount)} /{" "}
                                {formatBillionsOrTrillions(job.totalAmount)}
                              </div>
                            </div>
                            <div>
                              <span className="text-[11px] text-slate-500">Remaining on Job</span>
                              <div className="font-bold text-amber-700 tabular-nums">
                                {formatBillionsOrTrillions(job.remainingAmount)}
                              </div>
                            </div>
                            <div>
                              <span className="text-[11px] text-slate-500">Current / Next Account</span>
                              <div className="font-semibold text-indigo-700">
                                {activeOrNextChunk
                                  ? `${activeOrNextChunk.sourceSlotCode ?? "SLOT"}${
                                      activeOrNextChunk.sourceLagoslifeUsername
                                        ? ` (@${activeOrNextChunk.sourceLagoslifeUsername})`
                                        : ""
                                    }`
                                  : "All chunks finished"}
                              </div>
                            </div>
                            <div>
                              <span className="text-[11px] text-slate-500">Last Successful Transfer</span>
                              <div className="font-medium text-slate-800">
                                {lastSucceededChunk?.executedAt
                                  ? formatDateTime(lastSucceededChunk.executedAt)
                                  : "None yet"}
                              </div>
                            </div>
                            <div className="col-span-2 flex justify-between border-t border-slate-200/70 pt-1.5">
                              <span className="text-[11px] text-slate-500">
                                Failed or Ambiguous Chunks:
                              </span>
                              <span
                                className={`font-bold ${
                                  failedOrAmbiguousChunks.length > 0
                                    ? "text-rose-600"
                                    : "text-emerald-700"
                                }`}
                              >
                                {failedOrAmbiguousChunks.length}
                              </span>
                            </div>
                          </div>

                          {/* Job Controls with Explicit Confirmation */}
                          <div className="space-y-2">
                            <div className="flex flex-wrap gap-2">
                              {(job.status === "PENDING" || job.status === "RUNNING") && (
                                <>
                                  <Button
                                    onClick={() => setConfirmExecuteJobId(job.id)}
                                    disabled={disbBusy}
                                  >
                                    Execute Authorized Job
                                  </Button>
                                  <Button
                                    variant="secondary"
                                    onClick={() => handleJobAction(job.id, "pause")}
                                    disabled={disbBusy}
                                  >
                                    Pause
                                  </Button>
                                </>
                              )}
                              {job.status === "PAUSED" && (
                                <div className="flex flex-wrap items-center gap-2">
                                  {job.chunks.some(
                                    (c) =>
                                      c.status === "FAILED_RETRYABLE" &&
                                      typeof c.errorMessage === "string" &&
                                      c.errorMessage.startsWith("TWO_FACTOR_REQUIRED:")
                                  ) && (
                                    <input
                                      type="password"
                                      autoComplete="one-time-code"
                                      placeholder="One-time 2FA code"
                                      value={twoFactorByJob[job.id] ?? ""}
                                      onChange={(e) =>
                                        setTwoFactorByJob((prev) => ({
                                          ...prev,
                                          [job.id]: e.target.value,
                                        }))
                                      }
                                      className="rounded-lg border border-amber-300 bg-white px-2.5 py-1.5 text-xs"
                                    />
                                  )}
                                  <Button
                                    onClick={() => handleJobAction(job.id, "resume")}
                                    disabled={disbBusy || job.hasAmbiguousChunks}
                                  >
                                    Resume Job
                                  </Button>
                                </div>
                              )}
                              {job.status !== "COMPLETED" && job.status !== "FAILED" && (
                                <Button
                                  variant="secondary"
                                  onClick={() => setConfirmCancelJobId(job.id)}
                                  disabled={disbBusy || job.hasAmbiguousChunks}
                                >
                                  Cancel Job
                                </Button>
                              )}
                            </div>

                            {/* Explicit Owner Execution Confirmation Dialog */}
                            {confirmExecuteJobId === job.id && (
                              <div className="rounded-lg border border-indigo-300 bg-indigo-50 p-3 space-y-2 text-xs">
                                <div className="font-bold text-indigo-950">
                                  Confirm Live Disbursement Execution
                                </div>
                                <p className="text-indigo-900">
                                  Execute ready &le; 100B chunks for Job #{job.id.slice(0, 8)} to{" "}
                                  <strong>@{detail.recipientLagoslifeUsername}</strong>?
                                  {!disbursementEnabled && (
                                    <span className="block mt-1 font-semibold text-amber-800">
                                      Note: DISBURSEMENT_ENABLED=false is currently enforced in Safe Mode; the API will block live LagosLife /api/send calls until enabled.
                                    </span>
                                  )}
                                </p>
                                <div className="flex gap-2">
                                  <Button
                                    onClick={() => handleJobAction(job.id, "execute")}
                                    disabled={disbBusy}
                                  >
                                    {disbBusy ? "Executing..." : "Confirm & Execute Chunks"}
                                  </Button>
                                  <Button
                                    variant="secondary"
                                    onClick={() => setConfirmExecuteJobId(null)}
                                    disabled={disbBusy}
                                  >
                                    Cancel
                                  </Button>
                                </div>
                              </div>
                            )}

                            {/* Explicit Owner Cancellation Confirmation Dialog */}
                            {confirmCancelJobId === job.id && (
                              <div className="rounded-lg border border-rose-300 bg-rose-50 p-3 space-y-2 text-xs">
                                <div className="font-bold text-rose-900">
                                  Cancel Remaining Unsent Chunks
                                </div>
                                <input
                                  type="text"
                                  placeholder="Enter cancellation reason (required)"
                                  value={cancelJobReason}
                                  onChange={(e) => setCancelJobReason(e.target.value)}
                                  className="w-full rounded border border-rose-300 bg-white px-2.5 py-1.5 text-xs"
                                />
                                <div className="flex gap-2">
                                  <Button
                                    onClick={() =>
                                      handleJobAction(
                                        job.id,
                                        "cancel",
                                        cancelJobReason.trim() || "Cancelled by Owner"
                                      )
                                    }
                                    disabled={disbBusy || cancelJobReason.trim().length < 3}
                                  >
                                    Confirm Cancel Job
                                  </Button>
                                  <Button
                                    variant="secondary"
                                    onClick={() => setConfirmCancelJobId(null)}
                                    disabled={disbBusy}
                                  >
                                    Back
                                  </Button>
                                </div>
                              </div>
                            )}
                          </div>

                          {/* Chunks Breakdown & Ambiguous Chunk Resolution */}
                          <div className="space-y-2 pt-2">
                            <div className="text-xs font-semibold text-slate-700">
                              Transfer Chunks ({job.chunks.length})
                            </div>
                            <div className="max-h-72 overflow-y-auto space-y-2">
                              {job.chunks.map((chunk, idx) => (
                                <div
                                  key={chunk.id}
                                  className={`rounded-lg border p-2.5 text-xs ${
                                    chunk.status === "AMBIGUOUS_MANUAL_REVIEW"
                                      ? "border-amber-400 bg-amber-50"
                                      : chunk.status === "FAILED_TERMINAL" ||
                                          chunk.status === "FAILED_RETRYABLE"
                                        ? "border-rose-200 bg-rose-50/50"
                                        : "border-slate-200 bg-slate-50"
                                  }`}
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="font-semibold text-slate-900">
                                      Chunk #{idx + 1}: {formatBillionsOrTrillions(chunk.amount)} from{" "}
                                      {chunk.sourceSlotCode ?? "SLOT"}
                                      {chunk.sourceLagoslifeUsername
                                        ? ` (@${chunk.sourceLagoslifeUsername})`
                                        : ""}
                                    </span>
                                    <StatusBadge
                                      label={chunk.status}
                                      tone={getBadgeTone(chunk.status)}
                                    />
                                  </div>
                                  <div className="mt-1 text-[11px] text-slate-600">
                                    Recipient: @{chunk.recipientUsername}
                                    {chunk.resolvedTargetId
                                      ? ` (ID: ${chunk.resolvedTargetId})`
                                      : ""}{" "}
                                    &middot; Attempts: {chunk.attemptCount}
                                    {chunk.executedAt
                                      ? ` · Delivered ${formatDateTime(chunk.executedAt)}`
                                      : ""}
                                  </div>
                                  {chunk.errorMessage && (
                                    <div className="mt-1 text-[11px] font-medium text-rose-700">
                                      Error: {chunk.errorMessage}
                                    </div>
                                  )}
                                  {chunk.reconciliationNote && (
                                    <div className="mt-1 text-[11px] text-amber-900">
                                      Reconciliation: {chunk.reconciliationNote}
                                    </div>
                                  )}

                                  {chunk.status === "AMBIGUOUS_MANUAL_REVIEW" && (
                                    <div className="mt-2.5 space-y-2 border-t border-amber-300 pt-2">
                                      <div className="font-bold text-amber-950">
                                        Resolve Ambiguous Transfer Chunk
                                      </div>
                                      <p className="text-[11px] text-amber-900">
                                        Inspect the sender account&apos;s live balance on{" "}
                                        <Link
                                          href="/owner/inventory"
                                          className="underline font-semibold"
                                        >
                                          /owner/inventory
                                        </Link>{" "}
                                        before confirming whether this chunk was delivered.
                                      </p>
                                      <input
                                        type="text"
                                        placeholder="Mandatory audit note (e.g. Verified live balance delta on LagosLife)"
                                        value={ambiguousNotesByChunk[chunk.id] ?? ""}
                                        onChange={(e) =>
                                          setAmbiguousNotesByChunk((prev) => ({
                                            ...prev,
                                            [chunk.id]: e.target.value,
                                          }))
                                        }
                                        className="w-full rounded border border-amber-300 bg-white px-2.5 py-1.5 text-xs"
                                      />
                                      <div className="flex flex-wrap gap-2">
                                        <Button
                                          onClick={() =>
                                            handleResolveAmbiguousChunk(
                                              job.id,
                                              chunk.id,
                                              "CONFIRMED_DELIVERED"
                                            )
                                          }
                                          disabled={disbBusy}
                                        >
                                          Confirm Delivered (Debit Ledger)
                                        </Button>
                                        <Button
                                          variant="secondary"
                                          onClick={() =>
                                            handleResolveAmbiguousChunk(
                                              job.id,
                                              chunk.id,
                                              "CONFIRMED_NOT_DELIVERED"
                                            )
                                          }
                                          disabled={disbBusy}
                                        >
                                          Confirm Not Sent (Queue Retry)
                                        </Button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Manual Fulfilment Confirmation */}
              <div className="rounded-xl border border-slate-200 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-slate-900">
                    Record Manual LagosLife Delivery
                  </h3>
                  <StatusBadge
                    label={disbursementEnabled ? "Fallback" : "Primary Mode (DISBURSEMENT_ENABLED=false)"}
                    tone={disbursementEnabled ? "neutral" : "info"}
                  />
                </div>
                <p className="text-xs text-slate-600">
                  Logs an externally completed LagosLife transfer. Does not initiate an automatic transfer.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={manualAccountId}
                    onChange={(e) => setManualAccountId(e.target.value)}
                    className="rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                  >
                    <option value="">Select Account Slot</option>
                    {inventorySlots.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.slotCode} (@{s.lagoslifeUsername ?? "unconfigured"})
                      </option>
                    ))}
                  </select>
                  <div className="flex gap-1.5">
                    <input
                      type="number"
                      placeholder="Amount in Billions (e.g. 500)"
                      value={manualAmountBillions}
                      onChange={(e) => setManualAmountBillions(e.target.value)}
                      className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                    />
                    {(() => {
                      const req = parseBigIntSafe(detail.gameAmountRequested);
                      const ful = parseBigIntSafe(detail.fulfilledAmount);
                      const remB = req > ful ? (req - ful) / ONE_BILLION : 0n;
                      if (remB <= 0n) return null;
                      return (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => setManualAmountBillions(remB.toString())}
                        >
                          Fill {remB.toString()}B
                        </Button>
                      );
                    })()}
                  </div>
                </div>
                <input
                  type="text"
                  placeholder="External Transfer Reference (required)"
                  value={manualExternalRef}
                  onChange={(e) => setManualExternalRef(e.target.value)}
                  className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
                <input
                  type="text"
                  placeholder="Notes (optional)"
                  value={manualNotes}
                  onChange={(e) => setManualNotes(e.target.value)}
                  className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
                <Button
                  variant="primary"
                  onClick={handleManualFulfilment}
                  disabled={
                    disbBusy ||
                    !manualAccountId ||
                    !manualAmountBillions ||
                    Number(manualAmountBillions) <= 0 ||
                    !manualExternalRef.trim()
                  }
                >
                  Record Manual Delivery
                </Button>
              </div>

              {/* Refund Management */}
              <div className="rounded-xl border border-slate-200 p-4 space-y-3">
                <h3 className="text-sm font-bold text-slate-900">Refund Accounting</h3>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={refundScope}
                    onChange={(e) => setRefundScope(e.target.value as "FULL" | "PARTIAL")}
                    className="rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                  >
                    <option value="FULL">FULL REFUND</option>
                    <option value="PARTIAL">PARTIAL REFUND</option>
                  </select>
                  <input
                    type="number"
                    placeholder="Amount in NGN"
                    value={refundAmountNaira}
                    onChange={(e) => setRefundAmountNaira(e.target.value)}
                    className="rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                  />
                </div>
                <input
                  type="text"
                  placeholder="Refund Reason"
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
                <Button variant="secondary" onClick={handleRequestRefund} disabled={disbBusy}>
                  Create Refund Request
                </Button>
              </div>
            </div>
          )}
        </SlideOver>

        <SlideOver
          open={directOpen}
          onClose={() => setDirectOpen(false)}
          title="Direct / Pre-Paid Send"
          subtitle="Create an order for someone who already paid without requiring them to order first."
        >
          <form onSubmit={handleCreateDirectOrder} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Recipient LagosLife Username
              </label>
              <input
                type="text"
                required
                placeholder="e.g. player_username"
                value={directRecipient}
                onChange={(e) => setDirectRecipient(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Amount to Send (in T, e.g. 10 = 10T, 0.5 = 500B)
              </label>
              <input
                type="number"
                step="0.001"
                min="0.001"
                required
                value={directAmountT}
                onChange={(e) => setDirectAmountT(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2 font-mono-tabular text-sm"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={directPrePaid}
                onChange={(e) => setDirectPrePaid(e.target.checked)}
              />
              Already Paid (mark immediately Ready for Fulfilment)
            </label>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Payment / Audit Note
              </label>
              <input
                type="text"
                placeholder="e.g. Paid via direct transfer before launch"
                value={directReason}
                onChange={(e) => setDirectReason(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm"
              />
            </div>
            <Button type="submit" variant="owner" className="w-full" disabled={directBusy}>
              {directBusy ? "Creating..." : "Create & Open for Fulfilment"}
            </Button>
          </form>
        </SlideOver>
      </div>
    </OwnerShell>
  );
}
