"use client";

import React, { useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { formatDateTime, formatTrillions, type BadgeTone } from "@/lib/format";
import { OwnerShell } from "@/components/OwnerShell";
import { StatusBadge } from "@/components/ui/Badge";
import { SlideOver } from "@/components/ui/SlideOver";

interface SessionIdentityMeta {
  uid: string | null;
  username: string | null;
  simName: string | null;
  connectedAt: string | null;
  verifiedAt: string | null;
}

interface InventorySlot {
  id: string;
  slotCode: string;
  lagoslifeUsername: string | null;
  accountRole: string;
  healthStatus: string;
  effectiveHealthStatus: string;
  isStale: boolean;
  observedBalance: string;
  expectedBalance: string;
  reservedForOrders: string;
  netAvailableBalance: string;
  reservableAvailable: string;
  manualFulfilmentDebitsSinceSync: string;
  targetReserveAmount: string;
  logicalAllocationAmount: string;
  lastSyncedAt: string | null;
  sessionConnected: boolean;
  connectionStatus: "CONNECTED" | "SESSION_EXPIRED" | "DISCONNECTED";
  hasPin?: boolean;
  pinUpdatedAt?: string | null;
  sessionIdentity: SessionIdentityMeta | null;
  eligibleForFulfilment: boolean;
}

interface DiscrepancyRecord {
  id: string;
  expectedBalance: string;
  observedBalance: string;
  deltaAmount: string;
  status: string;
  createdAt: string;
  resolutionNotes?: string | null;
  gameAccount?: { slotCode: string; lagoslifeUsername: string | null };
}

interface LedgerRecord {
  id: string;
  slotCode: string;
  orderId: string | null;
  entryType: string;
  deltaAmount: string;
  balanceAfter: string;
  notes: string | null;
  createdAt: string;
}

interface PendingTwoFactorState {
  challenge: string;
  username: string;
  method: string;
  to: string | null;
  message: string;
}

function formatSlotTitle(slotCode: string): string {
  if (slotCode === "MAIN_TREASURY") return "Main Treasury";
  const match = /^RESERVE_(\d+)$/.exec(slotCode);
  if (match) return `Reserve ${match[1]}`;
  return slotCode.replace(/_/g, " ");
}

function slotSortRank(slotCode: string): number {
  if (slotCode === "MAIN_TREASURY") return 0;
  const match = /^RESERVE_(\d+)$/.exec(slotCode);
  if (match) return Number(match[1]);
  return 9999;
}

const SLOT_TITLES: Record<string, string> = new Proxy(
  {},
  {
    get: (_target, prop) => formatSlotTitle(String(prop)),
  }
);

const RESERVE_PLANNING_TARGET_UNITS = "70000000000000"; // 70T planning target

function getStatusTone(status: string): BadgeTone {
  switch (status) {
    case "CONNECTED":
    case "ACTIVE":
    case "RESOLVED":
      return "success";
    case "SESSION_EXPIRED":
    case "OPEN":
    case "DISABLED":
      return "danger";
    case "STALE":
    case "UNCONFIGURED":
    case "ACKNOWLEDGED":
      return "warning";
    default:
      return "neutral";
  }
}

export default function OwnerInventoryPage() {
  const [slots, setSlots] = useState<InventorySlot[]>([]);
  const [totals, setTotals] = useState<{
    observedBalance: string;
    reservedForOrders: string;
    netAvailableBalance: string;
    openDiscrepanciesCount: number;
  } | null>(null);
  const [discrepancies, setDiscrepancies] = useState<DiscrepancyRecord[]>([]);
  const [ledger, setLedger] = useState<LedgerRecord[]>([]);
  const [pinDraftBySlot, setPinDraftBySlot] = useState<Record<string, string>>({});
  const [replaceSlot, setReplaceSlot] = useState<InventorySlot | null>(null);
  const [replaceReason, setReplaceReason] = useState("");
  const [pipelineBySlot, setPipelineBySlot] = useState<
    Record<string, { locked: boolean; cooldownRemainingMs: number; activeChunkCount: number }>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  // Connect / Reconnect LagosLife modal state
  const [connectSlot, setConnectSlot] = useState<InventorySlot | null>(null);
  const [connectTab, setConnectTab] = useState<"credentials" | "cookie">("credentials");
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [twoFactorState, setTwoFactorState] = useState<PendingTwoFactorState | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [cookieInput, setCookieInput] = useState("");
  const [cookieUsername, setCookieUsername] = useState("");
  const [connectSubmitting, setConnectSubmitting] = useState(false);

  // Per-slot action state
  const [busySlotAction, setBusySlotAction] = useState<string | null>(null);
  const [syncingAllLive, setSyncingAllLive] = useState(false);

  // Manual Balance Sync modal
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncSlot, setSyncSlot] = useState("MAIN_TREASURY");
  const [syncBalance, setSyncBalance] = useState("");
  const [syncNotes, setSyncNotes] = useState("");

  // Logical Allocation modal
  const [allocOpen, setAllocOpen] = useState(false);
  const [allocSlot, setAllocSlot] = useState("RESERVE_1");
  const [allocTarget, setAllocTarget] = useState("70000000000000");
  const [allocReason, setAllocReason] = useState("");

  // Configure Slot Username modal
  const [configSlot, setConfigSlot] = useState<InventorySlot | null>(null);
  const [configUsername, setConfigUsername] = useState("");
  const [configReason, setConfigReason] = useState("");

  // Dynamic Add Reserve Account modal
  const [addReserveOpen, setAddReserveOpen] = useState(false);
  const [newReserveUsername, setNewReserveUsername] = useState("");
  const [newReserveTargetT, setNewReserveTargetT] = useState("70");
  const [newReserveReason, setNewReserveReason] = useState("");

  // Main Treasury -> Reserve Refill modal
  const [refillOpen, setRefillOpen] = useState(false);
  const [refillTargetSlot, setRefillTargetSlot] = useState("RESERVE_1");
  const [refillAmountT, setRefillAmountT] = useState("1");
  const [refillConfirm, setRefillConfirm] = useState(false);
  const [refillReason, setRefillReason] = useState("");

  const [submitting, setSubmitting] = useState(false);

  async function loadAll() {
    setLoading(true);
    setError("");
    try {
      const [invData, discData, pipeData] = await Promise.all([
        apiRequest<{
          openDiscrepanciesCount: number;
          totals: {
            observedBalance: string;
            reservedForOrders: string;
            netAvailableBalance: string;
          };
          slots: InventorySlot[];
          recentLedger: LedgerRecord[];
        }>("/owner/inventory"),
        apiRequest<{ discrepancies: DiscrepancyRecord[] }>("/owner/inventory/discrepancies"),
        apiRequest<{
          accounts: Array<{
            slotCode: string;
            locked: boolean;
            cooldownRemainingMs: number;
            activeChunkCount: number;
          }>;
        }>("/owner/operations/pipelines").catch(() => ({ accounts: [] })),
      ]);

      const nextPipeMap: Record<
        string,
        { locked: boolean; cooldownRemainingMs: number; activeChunkCount: number }
      > = {};
      for (const acc of pipeData.accounts ?? []) {
        nextPipeMap[acc.slotCode] = {
          locked: acc.locked,
          cooldownRemainingMs: acc.cooldownRemainingMs,
          activeChunkCount: acc.activeChunkCount,
        };
      }
      setPipelineBySlot(nextPipeMap);

      const sortedSlots = [...(invData.slots || [])].sort(
        (a, b) => slotSortRank(a.slotCode) - slotSortRank(b.slotCode) || a.slotCode.localeCompare(b.slotCode)
      );
      setSlots(sortedSlots);
      setTotals(
        invData.totals
          ? {
            ...invData.totals,
            openDiscrepanciesCount: invData.openDiscrepanciesCount ?? 0,
          }
          : null
      );
      setDiscrepancies(discData.discrepancies || []);
      setLedger(invData.recentLedger || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load inventory.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function handleAddReserveAccount(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      const targetUnits = BigInt(Math.max(0, Math.floor(Number(newReserveTargetT) || 0))) * 1_000_000_000_000n;
      const res = await apiRequest<{ account: { slotCode: string } }>("/owner/inventory/accounts", {
        method: "POST",
        body: JSON.stringify({
          lagoslifeUsername: newReserveUsername.trim() || undefined,
          targetReserveAmount: targetUnits.toString(),
          reason: newReserveReason.trim() || "Owner added dynamic reserve slot",
        }),
      });
      setMessage(`Created reserve slot ${res.account.slotCode}. Connect a LagosLife session to activate it.`);
      setAddReserveOpen(false);
      setNewReserveUsername("");
      setNewReserveReason("");
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create reserve slot.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRefillReserve(e: React.FormEvent) {
    e.preventDefault();
    if (!refillConfirm) {
      setError("Please check the transfer confirmation box before executing a Main Treasury refill.");
      return;
    }
    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      const trillions = Number(refillAmountT);
      if (!Number.isFinite(trillions) || trillions <= 0) {
        throw new Error("Enter a positive refill amount in Trillions (T).");
      }
      const units = BigInt(Math.round(trillions * 1_000)) * 1_000_000_000n; // supports 0.1T (100B) precision
      const res = await apiRequest<{
        refillId: string;
        status: string;
        chunkAmount: string;
        remainingAmount: string;
        queuedRemaining: boolean;
        error: string | null;
      }>("/owner/inventory/refill-reserve", {
        method: "POST",
        body: JSON.stringify({
          targetSlotCode: refillTargetSlot,
          amount: units.toString(),
          confirmTransfer: true,
          reason: refillReason.trim() || `Refill ${refillTargetSlot} from Main Treasury`,
        }),
      });
      if (res.status === "AMBIGUOUS_MANUAL_REVIEW") {
        setError(res.error || "Refill paused for manual verification (ambiguous transfer outcome).");
      } else {
        setMessage(
          res.queuedRemaining
            ? `Refill #${res.refillId} started (sent ${formatTrillions(res.chunkAmount)}; remaining ${formatTrillions(res.remainingAmount)} queued in 100B chunks).`
            : `Refill #${res.refillId} completed (${res.status}).`
        );
        setRefillOpen(false);
        setRefillConfirm(false);
        setRefillReason("");
      }
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refill reserve from Main Treasury.");
    } finally {
      setSubmitting(false);
    }
  }

  function openConnectModal(slot: InventorySlot) {
    setConnectSlot(slot);
    setConnectTab("credentials");
    const defaultUser =
      slot.lagoslifeUsername && !slot.lagoslifeUsername.startsWith("UNCONFIGURED")
        ? slot.lagoslifeUsername
        : slot.slotCode === "MAIN_TREASURY"
          ? "bigola2823"
          : "";
    setLoginUsername(defaultUser);
    setLoginPassword("");
    setTwoFactorState(null);
    setTwoFactorCode("");
    setCookieInput("");
    setCookieUsername(defaultUser);
    setError("");
  }

  async function handleCredentialsLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!connectSlot) return;
    setConnectSubmitting(true);
    setError("");
    setMessage("");
    try {
      const res = await apiRequest<
        | {
          status: "TWO_FACTOR_REQUIRED";
          slotCode: string;
          challenge: string;
          method: string;
          to: string | null;
          message: string;
        }
        | {
          status: "CONNECTED";
          slotCode: string;
          lagoslifeUsername: string;
          observedBalance: string;
        }
      >(`/owner/inventory/accounts/${connectSlot.slotCode}/connect/login`, {
        method: "POST",
        body: JSON.stringify({
          username: loginUsername.trim(),
          password: loginPassword,
        }),
      });

      if (res.status === "TWO_FACTOR_REQUIRED") {
        setTwoFactorState({
          challenge: res.challenge,
          username: loginUsername.trim(),
          method: res.method,
          to: res.to,
          message: res.message,
        });
        setLoginPassword("");
        setMessage(
          `2FA verification required for @${loginUsername.trim()}${res.to ? ` (${res.to})` : ""
          }. Enter the verification code below.`
        );
      } else {
        setLoginPassword("");
        setConnectSlot(null);
        setMessage(
          `Connected ${SLOT_TITLES[connectSlot.slotCode] ?? connectSlot.slotCode} (@${res.lagoslifeUsername
          }) and synchronized live balance (${formatTrillions(res.observedBalance)}).`
        );
        await loadAll();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "LagosLife login failed.");
    } finally {
      setConnectSubmitting(false);
    }
  }

  async function handleCompleteTwoFactor(e: React.FormEvent) {
    e.preventDefault();
    if (!connectSlot || !twoFactorState) return;
    setConnectSubmitting(true);
    setError("");
    setMessage("");
    try {
      const res = await apiRequest<{
        status: "CONNECTED";
        lagoslifeUsername: string;
        observedBalance: string;
      }>(`/owner/inventory/accounts/${connectSlot.slotCode}/connect/2fa`, {
        method: "POST",
        body: JSON.stringify({
          challenge: twoFactorState.challenge,
          code: twoFactorCode.trim(),
        }),
      });
      setTwoFactorState(null);
      setTwoFactorCode("");
      setConnectSlot(null);
      setMessage(
        `2FA verified and connected ${SLOT_TITLES[connectSlot.slotCode] ?? connectSlot.slotCode} (@${res.lagoslifeUsername
        }).`
      );
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "2FA verification failed.");
    } finally {
      setConnectSubmitting(false);
    }
  }

  async function handleResendTwoFactor() {
    if (!connectSlot || !twoFactorState) return;
    setConnectSubmitting(true);
    setError("");
    try {
      const res = await apiRequest<{
        ok: boolean;
        to: string | null;
      }>(`/owner/inventory/accounts/${connectSlot.slotCode}/connect/2fa/resend`, {
        method: "POST",
        body: JSON.stringify({ challenge: twoFactorState.challenge }),
      });
      setMessage(`Verification code resent${res.to ? ` to ${res.to}` : ""}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resend 2FA code.");
    } finally {
      setConnectSubmitting(false);
    }
  }

  async function handleCookieImport(e: React.FormEvent) {
    e.preventDefault();
    if (!connectSlot) return;
    setConnectSubmitting(true);
    setError("");
    setMessage("");
    try {
      const res = await apiRequest<{
        status: "CONNECTED";
        lagoslifeUsername: string;
        observedBalance: string;
      }>(`/owner/inventory/accounts/${connectSlot.slotCode}/connect/cookie`, {
        method: "POST",
        body: JSON.stringify({
          cookie: cookieInput.trim(),
          lagoslifeUsername: cookieUsername.trim() || undefined,
        }),
      });
      setCookieInput("");
      setConnectSlot(null);
      setMessage(
        `Session cookie imported and verified for ${SLOT_TITLES[connectSlot.slotCode] ?? connectSlot.slotCode
        } (@${res.lagoslifeUsername}).`
      );
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Session cookie import failed.");
    } finally {
      setConnectSubmitting(false);
    }
  }

  async function handleSaveAccountPin(slotCode: string) {
    const pinVal = (pinDraftBySlot[slotCode] ?? "").trim();
    if (pinVal.length < 4 || pinVal.length > 16) {
      setError("Transaction PIN must be 4 to 16 characters.");
      return;
    }
    setBusySlotAction(`pin:${slotCode}`);
    setError("");
    setMessage("");
    try {
      await apiRequest(`/owner/inventory/accounts/${slotCode}/pin`, {
        method: "PUT",
        body: JSON.stringify({
          pin: pinVal,
          reason: `Configured transaction PIN for ${slotCode} via Owner Control Centre`,
        }),
      });
      setPinDraftBySlot((prev) => ({ ...prev, [slotCode]: "" }));
      setMessage(`Transaction PIN encrypted and saved for ${SLOT_TITLES[slotCode] ?? slotCode}.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save transaction PIN.");
    } finally {
      setBusySlotAction(null);
    }
  }

  async function handleClearAccountPin(slotCode: string) {
    setBusySlotAction(`clearpin:${slotCode}`);
    setError("");
    setMessage("");
    try {
      await apiRequest(`/owner/inventory/accounts/${slotCode}/pin`, {
        method: "DELETE",
        body: JSON.stringify({
          reason: `Cleared transaction PIN for ${slotCode} via Owner Control Centre`,
        }),
      });
      setPinDraftBySlot((prev) => ({ ...prev, [slotCode]: "" }));
      setMessage(`Transaction PIN cleared for ${SLOT_TITLES[slotCode] ?? slotCode}.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear transaction PIN.");
    } finally {
      setBusySlotAction(null);
    }
  }

  async function handleReplaceReserveAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!replaceSlot) return;
    if (replaceReason.trim().length < 3) {
      setError("Enter an audit reason (min 3 chars) to replace this account.");
      return;
    }
    setBusySlotAction(`replace:${replaceSlot.slotCode}`);
    setError("");
    setMessage("");
    try {
      await apiRequest(`/owner/inventory/accounts/${replaceSlot.slotCode}/replace`, {
        method: "POST",
        body: JSON.stringify({
          confirm: true,
          reason: replaceReason.trim(),
        }),
      });
      const clearedSlot = replaceSlot;
      setReplaceSlot(null);
      setReplaceReason("");
      setMessage(
        `${SLOT_TITLES[clearedSlot.slotCode] ?? clearedSlot.slotCode} cleared securely (historical records preserved). Click "Connect Account" on ${clearedSlot.slotCode} to authenticate and verify the new LagosLife account.`
      );
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to replace reserve account.");
    } finally {
      setBusySlotAction(null);
    }
  }

  async function handleToggleEligibility(slot: InventorySlot) {
    const nextHealth = slot.healthStatus === "DISABLED" ? "ACTIVE" : "DISABLED";
    setBusySlotAction(`elig:${slot.slotCode}`);
    setError("");
    setMessage("");
    try {
      await apiRequest(`/owner/inventory/accounts/${slot.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          healthStatus: nextHealth,
          reason:
            nextHealth === "DISABLED"
              ? "Disabled eligibility via Owner Control Centre"
              : "Re-enabled eligibility via Owner Control Centre",
        }),
      });
      setMessage(
        `${SLOT_TITLES[slot.slotCode] ?? slot.slotCode} marked ${nextHealth}.`
      );
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update account eligibility.");
    } finally {
      setBusySlotAction(null);
    }
  }

  async function handleVerifySession(slotCode: string) {
    setBusySlotAction(`verify:${slotCode}`);
    setError("");
    setMessage("");
    try {
      const res = await apiRequest<{
        slotCode: string;
        valid: boolean;
        connectionStatus: string;
        sessionIdentity?: { username: string; simName: string | null };
      }>(`/owner/inventory/accounts/${slotCode}/verify-session`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (res.valid) {
        setMessage(
          `${SLOT_TITLES[slotCode] ?? slotCode} session is valid (@${res.sessionIdentity?.username ?? "verified"
          }).`
        );
      } else {
        setError(
          `${SLOT_TITLES[slotCode] ?? slotCode} session is not active (${res.connectionStatus}). Please reconnect.`
        );
      }
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Session verification failed.");
    } finally {
      setBusySlotAction(null);
    }
  }

  async function handleSyncLiveSlot(slotCode: string) {
    setBusySlotAction(`sync:${slotCode}`);
    setError("");
    setMessage("");
    try {
      const res = await apiRequest<{
        slotCode: string;
        lagoslifeUsername: string;
        observedBalance: string;
        discrepancy: { id: string; deltaAmount: string } | null;
      }>(`/owner/inventory/accounts/${slotCode}/sync-live`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setMessage(
        `Live balance synchronized for ${SLOT_TITLES[slotCode] ?? slotCode} (@${res.lagoslifeUsername
        }): ${formatTrillions(res.observedBalance)}${res.discrepancy ? " (Discrepancy flagged for review)" : ""
        }.`
      );
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Live balance synchronization failed.");
      await loadAll();
    } finally {
      setBusySlotAction(null);
    }
  }

  async function handleSyncAllLive() {
    setSyncingAllLive(true);
    setError("");
    setMessage("");
    try {
      const res = await apiRequest<{
        results: Array<{
          slotCode: string;
          status: "SYNCED" | "SKIPPED_DISCONNECTED" | "SESSION_EXPIRED" | "ERROR";
        }>;
      }>("/owner/inventory/sync-all-live", {
        method: "POST",
        body: JSON.stringify({}),
      });
      const syncedCount = res.results.filter(
        (r: { status: string }) => r.status === "SYNCED"
      ).length;
      const expiredCount = res.results.filter(
        (r: { status: string }) => r.status === "SESSION_EXPIRED"
      ).length;
      const skippedCount = res.results.filter(
        (r: { status: string }) => r.status === "SKIPPED_DISCONNECTED"
      ).length;
      setMessage(
        `Live synchronization finished: ${syncedCount} synced, ${expiredCount} session expired, ${skippedCount} disconnected.`
      );
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bulk live sync failed.");
    } finally {
      setSyncingAllLive(false);
    }
  }

  async function handleConfigureUsername(e: React.FormEvent) {
    e.preventDefault();
    if (!configSlot) return;
    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      await apiRequest(`/owner/inventory/accounts/${configSlot.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          lagoslifeUsername: configUsername.trim(),
          reason: configReason.trim() || "Configured LagosLife account username for slot",
        }),
      });
      setMessage(
        `Configured ${SLOT_TITLES[configSlot.slotCode] ?? configSlot.slotCode} username to @${configUsername.trim()}.`
      );
      setConfigSlot(null);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to configure slot username.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSyncBalance(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      await apiRequest("/owner/inventory/sync", {
        method: "POST",
        body: JSON.stringify({
          slotCode: syncSlot,
          observedBalance: syncBalance,
          reason: syncNotes.trim() || "Routine manual balance verification",
        }),
      });
      setMessage(`Balance synchronized for ${syncSlot}.`);
      setSyncOpen(false);
      setSyncBalance("");
      setSyncNotes("");
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUpdateAllocation(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      await apiRequest("/owner/inventory/allocate-reserve", {
        method: "POST",
        body: JSON.stringify({
          targetSlotCode: allocSlot,
          logicalAllocationAmount: allocTarget,
          reason: allocReason,
        }),
      });
      setMessage(`Logical allocation updated for ${allocSlot}.`);
      setAllocOpen(false);
      setAllocReason("");
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Allocation update failed.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResolveDiscrepancy(id: string, status: "ACKNOWLEDGED" | "RESOLVED") {
    const notes = window.prompt(
      "Enter resolution explanation (required for audit log):",
      "Verified against manual operational check"
    );
    if (!notes) return;
    setError("");
    try {
      await apiRequest(`/owner/inventory/discrepancies/${id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ status, resolutionNotes: notes }),
      });
      setMessage("Discrepancy updated.");
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve discrepancy.");
    }
  }

  const connectedSlotCount = slots.filter((s) => s.connectionStatus === "CONNECTED").length;

  return (
    <OwnerShell>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">
            Inventory & 5-Account LagosLife Topology
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Arrangement A: Main Treasury (@bigola2823) and Reserves 1–4 are independently authenticated, synchronized, and eligible for customer-order fulfilment.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleSyncAllLive}
            disabled={syncingAllLive}
            className="rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {syncingAllLive ? "Syncing Connected..." : "Sync All Connected Accounts"}
          </button>
          <button
            onClick={() => setAllocOpen(true)}
            className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            Logical Allocation
          </button>
          <button
            onClick={() => setSyncOpen(true)}
            className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            Manual Balance Entry
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {error}
        </div>
      )}
      {message && (
        <div className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          {message}
        </div>
      )}

      {totals && (
        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
            <p className="text-xs font-medium text-slate-500">Total Observed Stock</p>
            <p className="mt-1 text-xl font-bold text-slate-900 tabular-nums">
              {formatTrillions(totals.observedBalance)}
            </p>
            <p className="mt-1 text-[11px] text-slate-400">Across all {slots.length} fulfilment accounts</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
            <p className="text-xs font-medium text-slate-500">Reserved for Active Orders</p>
            <p className="mt-1 text-xl font-bold text-amber-700 tabular-nums">
              {formatTrillions(totals.reservedForOrders)}
            </p>
            <p className="mt-1 text-[11px] text-slate-400">Locked in awaiting/verified orders</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
            <p className="text-xs font-medium text-slate-500">Net Available Stock</p>
            <p className="mt-1 text-xl font-bold text-emerald-700 tabular-nums">
              {formatTrillions(totals.netAvailableBalance)}
            </p>
            <p className="mt-1 text-[11px] text-slate-400">Available for new reservations</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
            <p className="text-xs font-medium text-slate-500">Connected Sessions</p>
            <p className="mt-1 text-xl font-bold text-indigo-700 tabular-nums">
              {connectedSlotCount} / {slots.length}
            </p>
            <p className="mt-1 text-[11px] text-slate-400">Live AES-256-GCM encrypted sessions</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
            <p className="text-xs font-medium text-slate-500">Open Discrepancies</p>
            <p className="mt-1 text-xl font-bold text-slate-900 tabular-nums">
              {totals.openDiscrepanciesCount}
            </p>
            <p className="mt-1 text-[11px] text-slate-400">Unexplained balance variances</p>
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Fulfilment Account Topology ({slots.length} Accounts)
          </h2>
          <p className="text-xs text-slate-500">
            Each account maintains an isolated encrypted LagosLife session, independent live balance, and customer fulfilment eligibility.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const firstReserve = slots.find((s) => s.accountRole === "RESERVE");
              if (firstReserve) setRefillTargetSlot(firstReserve.slotCode);
              setRefillConfirm(false);
              setRefillOpen(true);
            }}
            className="rounded-lg border border-emerald-600 bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-700 cursor-pointer"
          >
            Refill Reserve from Treasury
          </button>
          <button
            type="button"
            onClick={() => setAddReserveOpen(true)}
            className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer"
          >
            + Add Reserve Account
          </button>
        </div>
      </div>

      {/* 5 Account Slots Grid */}
      <div className="mb-8 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        {loading ? (
          <div className="col-span-full rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
            Loading 5-account topology...
          </div>
        ) : (
          slots.map((slot) => {
            const isMain = slot.slotCode === "MAIN_TREASURY";
            const isUnconfigured =
              !slot.lagoslifeUsername || slot.lagoslifeUsername.startsWith("UNCONFIGURED");
            const slotTitle = SLOT_TITLES[slot.slotCode] ?? slot.slotCode;
            const planningTarget =
              !isMain && slot.targetReserveAmount === "0"
                ? RESERVE_PLANNING_TARGET_UNITS
                : slot.targetReserveAmount;
            const healthLabel = slot.effectiveHealthStatus || slot.healthStatus;

            return (
              <div
                key={slot.id}
                className={`flex flex-col justify-between rounded-xl border bg-white p-5 shadow-[0_1px_3px_rgba(11,19,36,0.05)] transition-all duration-200 hover:shadow-[0_6px_18px_rgba(11,19,36,0.07)] ${isMain
                  ? "border-[#0B1324]/30 ring-1 ring-[#059669]/25"
                  : "border-slate-200/90 hover:border-slate-300"
                  }`}
              >
                <div>
                  <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 pb-3">
                    <div className="min-w-0 flex-1">
                      <span
                        className={`block text-[11px] font-bold uppercase tracking-wider break-words ${isMain ? "text-[#059669]" : "text-indigo-600"
                          }`}
                      >
                        {slotTitle}
                      </span>
                      <p className="font-mono-tabular text-[11px] text-slate-400 break-all">{slot.slotCode}</p>
                    </div>
                    <StatusBadge
                      label={slot.connectionStatus}
                      tone={getStatusTone(slot.connectionStatus)}
                    />
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-2">
                    <h3 className="font-display truncate text-base font-bold text-[#0B1324]">
                      {isUnconfigured ? (
                        <span className="text-amber-700">Unconfigured Username</span>
                      ) : (
                        `@${slot.lagoslifeUsername}`
                      )}
                    </h3>
                    {!isMain && (
                      <button
                        type="button"
                        onClick={() => {
                          setConfigSlot(slot);
                          setConfigUsername(isUnconfigured ? "" : slot.lagoslifeUsername ?? "");
                          setConfigReason("");
                        }}
                        className="shrink-0 text-xs font-semibold text-indigo-600 hover:text-indigo-800 cursor-pointer"
                      >
                        Edit Username
                      </button>
                    )}
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    <StatusBadge label={healthLabel} tone={getStatusTone(healthLabel)} />
                    <span
                      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${slot.eligibleForFulfilment && slot.connectionStatus === "CONNECTED" && !slot.isStale
                        ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
                        : "bg-slate-100 text-slate-700 ring-slate-300/60"
                        }`}
                    >
                      {slot.eligibleForFulfilment && slot.connectionStatus === "CONNECTED" && !slot.isStale
                        ? "Eligible & Ready"
                        : "Needs Session / Sync"}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${slot.hasPin
                        ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
                        : "bg-amber-50 text-amber-800 ring-amber-600/20"
                        }`}
                    >
                      {slot.hasPin ? "PIN Configured" : "No PIN Set"}
                    </span>
                  </div>

                  {slot.connectionStatus === "SESSION_EXPIRED" && (
                    <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
                      Session expired on LagosLife. Reconnect session before authorizing disbursements from this account.
                    </div>
                  )}
                  {slot.connectionStatus === "DISCONNECTED" && (
                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                      No active LagosLife session connected. Click &ldquo;Connect Account&rdquo; below to authenticate.
                    </div>
                  )}
                  {slot.connectionStatus === "CONNECTED" && slot.isStale && (
                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                      Balance sync is stale. Click &ldquo;Sync Live Balance&rdquo; to refresh before fulfilment.
                    </div>
                  )}

                  <div className="mt-4 grid grid-cols-3 gap-2 rounded-xl border border-slate-100 bg-[#F8FAFC] p-3 text-center">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                        Observed
                      </p>
                      <p className="font-mono-tabular mt-0.5 text-sm font-bold text-[#0B1324]">
                        {formatTrillions(slot.observedBalance)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                        Reserved
                      </p>
                      <p className="font-mono-tabular mt-0.5 text-sm font-semibold text-amber-700">
                        {formatTrillions(slot.reservedForOrders)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                        Available
                      </p>
                      <p className="font-mono-tabular mt-0.5 text-sm font-bold text-emerald-700">
                        {formatTrillions(slot.netAvailableBalance)}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 space-y-1.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Expected Ledger:</span>
                      <span className="font-mono-tabular font-medium text-slate-700">
                        {formatTrillions(slot.expectedBalance)}
                      </span>
                    </div>
                    {!isMain && (
                      <div className="flex justify-between">
                        <span className="text-slate-500">Planning Target:</span>
                        <span className="font-mono-tabular font-medium text-indigo-600">
                          {formatTrillions(planningTarget)} (Target)
                        </span>
                      </div>
                    )}
                    {slot.sessionIdentity?.simName && (
                      <div className="flex justify-between">
                        <span className="text-slate-500">LagosLife Sim:</span>
                        <span className="truncate font-medium text-slate-700">
                          {slot.sessionIdentity.simName}
                        </span>
                      </div>
                    )}
                  </div>

                  <p className="mt-3 text-[11px] text-slate-400">
                    {slot.lastSyncedAt
                      ? `Last synced ${formatDateTime(slot.lastSyncedAt)}`
                      : "Never synchronized"}
                  </p>
                  {pipelineBySlot[slot.slotCode] && (
                    <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                      <span
                        className={`rounded px-1.5 py-0.5 font-semibold ${pipelineBySlot[slot.slotCode].locked
                          ? "bg-amber-100 text-amber-800"
                          : "bg-slate-100 text-slate-600"
                          }`}
                      >
                        {pipelineBySlot[slot.slotCode].locked ? "Lock: HELD" : "Lock: Free"}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 font-semibold ${pipelineBySlot[slot.slotCode].cooldownRemainingMs > 0
                          ? "bg-indigo-100 text-indigo-800"
                          : "bg-emerald-50 text-emerald-700"
                          }`}
                      >
                        {pipelineBySlot[slot.slotCode].cooldownRemainingMs > 0
                          ? `Cooldown: ${Math.ceil(pipelineBySlot[slot.slotCode].cooldownRemainingMs / 1000)}s`
                          : "Cooldown: Ready"}
                      </span>
                    </div>
                  )}
                </div>

                <div className="mt-4 space-y-2 border-t border-slate-100 pt-3.5">
                  <button
                    type="button"
                    onClick={() => openConnectModal(slot)}
                    className="w-full rounded-lg bg-[#0B1324] px-3 py-2 text-xs font-semibold text-white hover:bg-[#162340] transition-colors cursor-pointer"
                  >
                    {slot.sessionConnected ? "Reconnect Session" : "Connect Account"}
                  </button>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={!slot.sessionConnected || busySlotAction !== null}
                      onClick={() => handleSyncLiveSlot(slot.slotCode)}
                      className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-40 transition-colors cursor-pointer"
                    >
                      {busySlotAction === `sync:${slot.slotCode}`
                        ? "Syncing..."
                        : "Sync Live Balance"}
                    </button>
                    <button
                      type="button"
                      disabled={!slot.sessionConnected || busySlotAction !== null}
                      onClick={() => handleVerifySession(slot.slotCode)}
                      className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-[#0B1324] hover:bg-slate-50 disabled:opacity-40 transition-colors cursor-pointer"
                    >
                      {busySlotAction === `verify:${slot.slotCode}`
                        ? "Checking..."
                        : "Verify Session"}
                    </button>
                  </div>
                  <button
                    type="button"
                    disabled={busySlotAction !== null}
                    onClick={() => handleToggleEligibility(slot)}
                    className={`w-full rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition-colors cursor-pointer disabled:opacity-40 ${slot.healthStatus === "DISABLED"
                      ? "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                      : "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
                      }`}
                  >
                    {busySlotAction === `elig:${slot.slotCode}`
                      ? "Updating..."
                      : slot.healthStatus === "DISABLED"
                        ? "Enable Account Eligibility"
                        : "Disable Account Eligibility"}
                  </button>
                  {!isMain && (
                    <button
                      type="button"
                      disabled={
                        busySlotAction !== null ||
                        BigInt(slot.reservedForOrders) > 0n ||
                        Boolean(pipelineBySlot[slot.slotCode]?.locked)
                      }
                      onClick={() => {
                        setReplaceSlot(slot);
                        setReplaceReason("");
                        setError("");
                      }}
                      className="w-full rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-40 transition-colors cursor-pointer"
                    >
                      Replace Account
                    </button>
                  )}
                  {slot.sessionConnected && (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 space-y-1.5">
                      <div className="flex items-center justify-between text-[10px] font-semibold text-slate-600">
                        <span>Transaction PIN</span>
                        <span>{slot.hasPin ? "Encrypted on file" : "Not configured"}</span>
                      </div>
                      <div className="flex gap-1.5">
                        <input
                          type="password"
                          autoComplete="new-password"
                          placeholder={slot.hasPin ? "New PIN to rotate" : "Enter PIN (4–16 chars)"}
                          value={pinDraftBySlot[slot.slotCode] ?? ""}
                          onChange={(e) =>
                            setPinDraftBySlot((prev) => ({ ...prev, [slot.slotCode]: e.target.value }))
                          }
                          className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px]"
                        />
                        <button
                          type="button"
                          disabled={busySlotAction !== null || !(pinDraftBySlot[slot.slotCode] ?? "").trim()}
                          onClick={() => handleSaveAccountPin(slot.slotCode)}
                          className="rounded bg-[#0B1324] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#162340] disabled:opacity-40 cursor-pointer"
                        >
                          {busySlotAction === `pin:${slot.slotCode}` ? "..." : slot.hasPin ? "Update" : "Save"}
                        </button>
                        {slot.hasPin && (
                          <button
                            type="button"
                            disabled={busySlotAction !== null}
                            onClick={() => handleClearAccountPin(slot.slotCode)}
                            className="rounded border border-rose-200 bg-white px-2 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-40 cursor-pointer"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Discrepancies */}
      <div className="mb-8 rounded-xl border border-slate-200 bg-white shadow-xs">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-900">
            Inventory Discrepancies & Reconciliation
          </h2>
          <p className="text-xs text-slate-500">
            Automatically detected whenever observed LagosLife balance differs from expected ledger balance.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">
              <tr>
                <th className="px-6 py-3">Slot</th>
                <th className="px-6 py-3">Expected</th>
                <th className="px-6 py-3">Observed</th>
                <th className="px-6 py-3">Delta</th>
                <th className="px-6 py-3">Status</th>
                <th className="px-6 py-3">Detected</th>
                <th className="px-6 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {discrepancies.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-slate-400">
                    No balance discrepancies detected.
                  </td>
                </tr>
              ) : (
                discrepancies.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50/80">
                    <td className="px-6 py-4 font-semibold text-slate-900">
                      {d.gameAccount?.slotCode ?? "—"}
                    </td>
                    <td className="px-6 py-4 tabular-nums">
                      {formatTrillions(d.expectedBalance)}
                    </td>
                    <td className="px-6 py-4 tabular-nums">
                      {formatTrillions(d.observedBalance)}
                    </td>
                    <td className="px-6 py-4 font-semibold text-rose-600 tabular-nums">
                      {formatTrillions(d.deltaAmount)}
                    </td>
                    <td className="px-6 py-4">
                      <StatusBadge label={d.status} tone={getStatusTone(d.status)} />
                    </td>
                    <td className="px-6 py-4 text-xs text-slate-500">
                      {formatDateTime(d.createdAt)}
                    </td>
                    <td className="px-6 py-4 text-right">
                      {d.status === "OPEN" ? (
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => handleResolveDiscrepancy(d.id, "RESOLVED")}
                            className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
                          >
                            Resolve
                          </button>
                          <button
                            onClick={() => handleResolveDiscrepancy(d.id, "ACKNOWLEDGED")}
                            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            Acknowledge
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">
                          {d.resolutionNotes || "Closed"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Ledger Entries */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-xs">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-900">Recent Inventory Ledger</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">
              <tr>
                <th className="px-6 py-3">Timestamp</th>
                <th className="px-6 py-3">Slot</th>
                <th className="px-6 py-3">Entry Type</th>
                <th className="px-6 py-3">Delta</th>
                <th className="px-6 py-3">Balance After</th>
                <th className="px-6 py-3">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ledger.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-slate-400">
                    No ledger movements recorded yet.
                  </td>
                </tr>
              ) : (
                ledger.map((entry) => (
                  <tr key={entry.id}>
                    <td className="px-6 py-3.5 text-xs text-slate-500">
                      {formatDateTime(entry.createdAt)}
                    </td>
                    <td className="px-6 py-3.5 text-xs font-semibold text-slate-800">
                      {entry.slotCode || "—"}
                    </td>
                    <td className="px-6 py-3.5">
                      <StatusBadge label={entry.entryType} tone="info" />
                    </td>
                    <td className="px-6 py-3.5 font-mono text-xs font-semibold">
                      {formatTrillions(entry.deltaAmount)}
                    </td>
                    <td className="px-6 py-3.5 font-mono text-xs text-slate-600">
                      {formatTrillions(entry.balanceAfter)}
                    </td>
                    <td className="px-6 py-3.5 text-xs text-slate-600">{entry.notes || "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Connect / Reconnect LagosLife Account SlideOver */}
      <SlideOver
        open={connectSlot !== null}
        onClose={() => {
          setConnectSlot(null);
          setTwoFactorState(null);
          setLoginPassword("");
          setCookieInput("");
        }}
        title={
          connectSlot
            ? `Connect ${SLOT_TITLES[connectSlot.slotCode] ?? connectSlot.slotCode} (${connectSlot.slotCode})`
            : "Connect LagosLife Account"
        }
        subtitle="Authenticate directly with LagosLife or import a verified session cookie. Sessions are encrypted at rest with AES-256-GCM and never exposed after storage."
      >
        {connectSlot && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => {
                  setConnectTab("credentials");
                  setTwoFactorState(null);
                }}
                className={`rounded-md py-1.5 text-xs font-semibold ${connectTab === "credentials"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
                  }`}
              >
                Username & Password
              </button>
              <button
                type="button"
                onClick={() => {
                  setConnectTab("cookie");
                  setTwoFactorState(null);
                }}
                className={`rounded-md py-1.5 text-xs font-semibold ${connectTab === "cookie"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
                  }`}
              >
                Import Session Cookie
              </button>
            </div>

            {connectTab === "credentials" && !twoFactorState && (
              <form onSubmit={handleCredentialsLogin} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    LagosLife Username
                  </label>
                  <input
                    type="text"
                    required
                    value={loginUsername}
                    readOnly={connectSlot.slotCode === "MAIN_TREASURY"}
                    onChange={(e) => setLoginUsername(e.target.value)}
                    placeholder="e.g. bigola2823"
                    className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm read-only:bg-slate-100"
                  />
                  {connectSlot.slotCode === "MAIN_TREASURY" && (
                    <p className="mt-1 text-[11px] text-slate-500">
                      Main Treasury is locked to primary supplier @bigola2823.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    LagosLife Password
                  </label>
                  <input
                    type="password"
                    required
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="Enter LagosLife password (never stored)"
                    className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    Used one time to establish the LagosLife session. Plaintext passwords are never saved.
                  </p>
                </div>
                <button
                  type="submit"
                  disabled={connectSubmitting}
                  className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {connectSubmitting ? "Authenticating with LagosLife..." : "Sign In & Sync Live Balance"}
                </button>
              </form>
            )}

            {connectTab === "credentials" && twoFactorState && (
              <form onSubmit={handleCompleteTwoFactor} className="space-y-4">
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                  LagosLife requested 2FA verification for{" "}
                  <strong>@{twoFactorState.username}</strong>
                  {twoFactorState.to ? ` (${twoFactorState.to})` : ""}.
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    6-Digit Verification Code
                  </label>
                  <input
                    type="text"
                    required
                    value={twoFactorCode}
                    onChange={(e) => setTwoFactorCode(e.target.value)}
                    placeholder="Enter 6-digit code"
                    className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={connectSubmitting}
                    className="flex-1 rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {connectSubmitting ? "Verifying 2FA..." : "Complete 2FA & Connect"}
                  </button>
                  <button
                    type="button"
                    disabled={connectSubmitting}
                    onClick={handleResendTwoFactor}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    Resend Code
                  </button>
                </div>
              </form>
            )}

            {connectTab === "cookie" && (
              <form onSubmit={handleCookieImport} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Expected LagosLife Username (Optional if slot already configured)
                  </label>
                  <input
                    type="text"
                    value={cookieUsername}
                    readOnly={connectSlot.slotCode === "MAIN_TREASURY"}
                    onChange={(e) => setCookieUsername(e.target.value)}
                    placeholder="e.g. bigola2823"
                    className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm read-only:bg-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    LagosLife Session Cookie String
                  </label>
                  <textarea
                    rows={4}
                    required
                    value={cookieInput}
                    onChange={(e) => setCookieInput(e.target.value)}
                    placeholder="Paste ll_session=... cookie header"
                    className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    Verified immediately against LagosLife /api/auth/me and /api/save before AES-256-GCM encryption.
                  </p>
                </div>
                <button
                  type="submit"
                  disabled={connectSubmitting}
                  className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {connectSubmitting ? "Verifying Cookie..." : "Import Cookie & Sync Live Balance"}
                </button>
              </form>
            )}
          </div>
        )}
      </SlideOver>

      {/* Configure Reserve Slot Username SlideOver */}
      <SlideOver
        open={configSlot !== null}
        onClose={() => setConfigSlot(null)}
        title={
          configSlot
            ? `Configure ${SLOT_TITLES[configSlot.slotCode] ?? configSlot.slotCode} Username`
            : "Configure Slot Username"
        }
        subtitle="Assign the LagosLife username that belongs to this reserve account slot."
      >
        <form onSubmit={handleConfigureUsername} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700">LagosLife Username</label>
            <input
              type="text"
              required
              value={configUsername}
              onChange={(e) => setConfigUsername(e.target.value)}
              placeholder="e.g. reserve_account_1"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700">Audit Reason</label>
            <input
              type="text"
              required
              value={configReason}
              onChange={(e) => setConfigReason(e.target.value)}
              placeholder="Assigning LagosLife reserve account to slot"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting ? "Saving..." : "Save Slot Username"}
          </button>
        </form>
      </SlideOver>

      {/* Replace Reserve Account Confirmation SlideOver */}
      <SlideOver
        open={Boolean(replaceSlot)}
        onClose={() => {
          setReplaceSlot(null);
          setReplaceReason("");
        }}
        title={`Replace ${replaceSlot ? (SLOT_TITLES[replaceSlot.slotCode] ?? replaceSlot.slotCode) : "Reserve Account"}`}
        subtitle="Clears the old session, transaction PIN, and username so you can connect a new LagosLife account. Historical transactions, disbursement chunks, and audit logs are preserved."
      >
        {replaceSlot && (
          <form onSubmit={handleReplaceReserveAccount} className="space-y-4">
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 space-y-1">
              <p className="font-semibold">
                Current Account: {replaceSlot.lagoslifeUsername ? `@${replaceSlot.lagoslifeUsername}` : "Unconfigured"}
              </p>
              <p>
                This will immediately clear the encrypted session cookie, saved transaction PIN, and slot username, and mark {replaceSlot.slotCode} as UNCONFIGURED until you connect and verify the replacement account.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Audit Reason (required, min 3 chars)
              </label>
              <input
                type="text"
                required
                minLength={3}
                value={replaceReason}
                onChange={(e) => setReplaceReason(e.target.value)}
                placeholder="e.g. Rotating reserve account to new LagosLife wallet"
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={busySlotAction !== null || replaceReason.trim().length < 3}
                className="flex-1 rounded-lg bg-rose-600 py-2.5 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {busySlotAction === `replace:${replaceSlot.slotCode}`
                  ? "Replacing..."
                  : "Confirm Replace Account"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setReplaceSlot(null);
                  setReplaceReason("");
                }}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </SlideOver>

      {/* Sync Balance SlideOver */}
      <SlideOver
        open={syncOpen}
        onClose={() => setSyncOpen(false)}
        title="Manual Balance Entry"
        subtitle="Record a manually observed balance for an account slot. If it differs from the expected ledger balance, a discrepancy record will be flagged automatically."
      >
        <form onSubmit={handleSyncBalance} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700">Account Slot</label>
            <select
              value={syncSlot}
              onChange={(e) => setSyncSlot(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              {slots.map((s) => (
                <option key={s.slotCode} value={s.slotCode}>
                  {SLOT_TITLES[s.slotCode] ?? s.slotCode} (@{s.lagoslifeUsername ?? "unconfigured"})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700">
              Observed Balance (Raw Currency Units)
            </label>
            <input
              type="text"
              required
              value={syncBalance}
              onChange={(e) => setSyncBalance(e.target.value)}
              placeholder="e.g. 70000000000000 for 70T"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
            />
            <p className="mt-1 text-xs text-slate-500">
              1B = 1,000,000,000 | 1T = 1,000,000,000,000 | 70T = 70,000,000,000,000
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700">Notes</label>
            <textarea
              rows={2}
              value={syncNotes}
              onChange={(e) => setSyncNotes(e.target.value)}
              placeholder="Routine balance check"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting ? "Synchronizing..." : "Record Observed Balance"}
          </button>
        </form>
      </SlideOver>

      {/* Logical Allocation SlideOver */}
      <SlideOver
        open={allocOpen}
        onClose={() => setAllocOpen(false)}
        title="Update Logical Allocation Target"
        subtitle="Record a planning allocation target (such as 70T for a reserve slot) without moving live game currency."
      >
        <form onSubmit={handleUpdateAllocation} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700">Account Slot</label>
            <select
              value={allocSlot}
              onChange={(e) => setAllocSlot(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              {slots.map((s) => (
                <option key={s.slotCode} value={s.slotCode}>
                  {SLOT_TITLES[s.slotCode] ?? s.slotCode} (@{s.lagoslifeUsername ?? "unconfigured"})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700">
              Allocation Target (Raw Units)
            </label>
            <input
              type="text"
              required
              value={allocTarget}
              onChange={(e) => setAllocTarget(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700">Reason</label>
            <input
              type="text"
              required
              value={allocReason}
              onChange={(e) => setAllocReason(e.target.value)}
              placeholder="Set 70T reserve planning target"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting ? "Updating..." : "Save Logical Allocation"}
          </button>
        </form>
      </SlideOver>

      <SlideOver
        open={addReserveOpen}
        onClose={() => setAddReserveOpen(false)}
        title="Add Dynamic Reserve Account"
        subtitle="Create a new RESERVE_N fulfilment slot without altering existing accounts."
      >
        <form onSubmit={handleAddReserveAccount} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700">
              LagosLife Username (optional)
            </label>
            <input
              type="text"
              value={newReserveUsername}
              onChange={(e) => setNewReserveUsername(e.target.value)}
              placeholder="e.g. reserve_account_5"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700">
              Target Reserve Planning Amount (T)
            </label>
            <input
              type="number"
              min={0}
              value={newReserveTargetT}
              onChange={(e) => setNewReserveTargetT(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700">Audit Reason</label>
            <input
              type="text"
              required
              minLength={3}
              value={newReserveReason}
              onChange={(e) => setNewReserveReason(e.target.value)}
              placeholder="Expand reserve capacity"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-slate-900 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {submitting ? "Creating..." : "Create Reserve Account"}
          </button>
        </form>
      </SlideOver>

      <SlideOver
        open={refillOpen}
        onClose={() => setRefillOpen(false)}
        title="Refill Reserve from Main Treasury"
        subtitle="Executes real LagosLife transfer(s) in <=100B chunks with 30.5s cooldown."
      >
        <form onSubmit={handleRefillReserve} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700">
              Target Reserve Account
            </label>
            <select
              value={refillTargetSlot}
              onChange={(e) => setRefillTargetSlot(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              {slots
                .filter((s) => s.accountRole === "RESERVE")
                .map((s) => (
                  <option key={s.slotCode} value={s.slotCode}>
                    {formatSlotTitle(s.slotCode)} (@{s.lagoslifeUsername ?? "unconfigured"})
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700">
              Transfer Amount in Trillions (T) — supports 0.1T (100B) steps
            </label>
            <input
              type="number"
              step="0.1"
              min="0.1"
              required
              value={refillAmountT}
              onChange={(e) => setRefillAmountT(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700">Audit Reason</label>
            <input
              type="text"
              required
              minLength={3}
              value={refillReason}
              onChange={(e) => setRefillReason(e.target.value)}
              placeholder="Refill reserve slot for customer orders"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <input
              type="checkbox"
              checked={refillConfirm}
              onChange={(e) => setRefillConfirm(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              I confirm executing a live LagosLife transfer from <strong>MAIN_TREASURY</strong> to{" "}
              <strong>{refillTargetSlot}</strong>.
            </span>
          </label>
          <button
            type="submit"
            disabled={submitting || !refillConfirm}
            className="w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {submitting ? "Executing Refill..." : "Confirm & Refill Reserve"}
          </button>
        </form>
      </SlideOver>
    </OwnerShell>
  );
}
