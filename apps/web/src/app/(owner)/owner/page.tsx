"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiRequest } from "@/lib/api";
import { formatDateTime, formatNaira, formatTrillions } from "@/lib/format";
import { OwnerShell } from "@/components/OwnerShell";
import { Card, StatCard } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { OrderStatusBadge, StatusBadge } from "@/components/ui/Badge";

interface AccountabilityData {
  paymentsVerified: {
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

interface InventoryOverview {
  totals: {
    observedBalance: string;
    reservedForOrders: string;
    reservableAvailable: string;
  };
}

interface OwnerOrderRow {
  id: string;
  orderNumber: string;
  fiatAmountKobo: string;
  status: string;
  createdAt: string;
  customer?: { fullName: string };
}

interface AccountPipelineState {
  id: string;
  slotCode: string;
  accountRole: string;
  lagoslifeUsername: string | null;
  healthStatus: string;
  connectionStatus: "CONNECTED" | "SESSION_EXPIRED" | "DISCONNECTED";
  observedBalance: string;
  reservedForOrders: string;
  netAvailableBalance: string;
  lastSyncedAt: string | null;
  locked: boolean;
  cooldownRemainingMs: number;
  activeChunkCount: number;
  rateLimitedChunkCount: number;
  ambiguousChunkCount: number;
}

interface PipelineJobSummary {
  id: string;
  orderId: string;
  orderNumber: string | null;
  orderStatus: string | null;
  recipientLagoslifeUsername: string | null;
  totalAmount: string;
  deliveredAmount: string;
  remainingAmount: string;
  status: string;
  totalChunks: number;
  completedChunks: number;
  progressPercent: number;
  hasAmbiguousChunks: boolean;
  allocatedSlotCodes: string[];
  rateLimitedChunks: number;
  ambiguousChunks: number;
  createdAt: string;
}

interface OperationalPipelineResponse {
  disbursementEnabled: boolean;
  summary: {
    runningJobs: number;
    queuedJobs: number;
    pausedJobs: number;
    completedJobs: number;
    failedJobs: number;
    expiredSessionAccountsCount: number;
    ambiguousChunksCount: number;
    rateLimitedChunksCount: number;
  };
  accounts: AccountPipelineState[];
  jobs: PipelineJobSummary[];
  queueStats: {
    connected: boolean;
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    completed: number;
  };
  workerHeartbeat: {
    alive: boolean;
    lastHeartbeatAt: string | null;
    service: string | null;
    disbursementEnabled: boolean | null;
  };
}

function formatCooldownSec(ms: number): string {
  if (ms <= 0) return "Ready";
  return `${(ms / 1000).toFixed(1)}s cooldown`;
}

function jobTone(status: string): "success" | "warning" | "danger" | "info" | "neutral" {
  switch (status) {
    case "COMPLETED":
      return "success";
    case "RUNNING":
      return "info";
    case "PAUSED":
    case "PARTIAL":
      return "warning";
    case "FAILED":
      return "danger";
    default:
      return "neutral";
  }
}

export default function OwnerOverviewPage() {
  const [accountability, setAccountability] = useState<AccountabilityData | null>(null);
  const [inventory, setInventory] = useState<InventoryOverview | null>(null);
  const [orders, setOrders] = useState<OwnerOrderRow[]>([]);
  const [pipelines, setPipelines] = useState<OperationalPipelineResponse | null>(null);
  const [conflictsCount, setConflictsCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDashboard = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const [acc, inv, ord, conf, pipe] = await Promise.all([
        apiRequest<AccountabilityData>("/owner/financial-accountability"),
        apiRequest<InventoryOverview>("/owner/inventory"),
        apiRequest<{ orders: OwnerOrderRow[] }>("/owner/orders"),
        apiRequest<{ conflicts: Array<{ status: string }> }>("/owner/attribution-conflicts"),
        apiRequest<OperationalPipelineResponse>("/owner/operations/pipelines").catch(() => null),
      ]);
      setAccountability(acc);
      setInventory(inv);
      setOrders(ord.orders.slice(0, 8));
      setConflictsCount(conf.conflicts.filter((c) => c.status === "PENDING").length);
      setPipelines(pipe);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Owner dashboard.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadDashboard(false);
  }, [loadDashboard]);

  return (
    <OwnerShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">
              Operations &amp; Business Command Center
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Live 5-account sending pipelines, worker health, inventory, and financial accountability.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void loadDashboard(true)}
              disabled={refreshing}
            >
              {refreshing ? "Refreshing…" : "Refresh Telemetry"}
            </Button>
            <Link href="/owner/inventory">
              <Button variant="secondary" size="sm">
                Manage 5 Accounts
              </Button>
            </Link>
            <Link href="/owner/orders">
              <Button variant="secondary" size="sm">
                Disbursement Orders
              </Button>
            </Link>
            <Link href="/owner/verification">
              <Button variant="owner" size="sm">
                Open Verification Desk
              </Button>
            </Link>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <Card>
            <p className="text-sm text-slate-500">Loading Owner dashboard…</p>
          </Card>
        ) : (
          <>
            {/* Top Business & Stock KPIs */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="Net Verified Sales"
                value={
                  accountability
                    ? formatNaira(accountability.paymentsVerified.netVerifiedCustomerPaymentsKobo)
                    : "—"
                }
                accentColor="text-[#059669]"
              />
              <StatCard
                label="Pending Payments"
                value={accountability ? formatNaira(accountability.outstandingBalancesKobo) : "—"}
                accentColor="text-amber-600"
              />
              <StatCard
                label="Partner Commission Liability"
                value={
                  accountability
                    ? formatNaira(accountability.commissionEntitlements.totalNetPartnerEntitlementKobo)
                    : "—"
                }
                accentColor="text-[#4F46E5]"
              />
              <StatCard
                label="Reservable Stock"
                value={inventory ? formatTrillions(inventory.totals.reservableAvailable) : "—"}
                hint={
                  inventory
                    ? `Observed: ${formatTrillions(inventory.totals.observedBalance)} • Reserved: ${formatTrillions(inventory.totals.reservedForOrders)}`
                    : undefined
                }
              />
            </div>

            {/* Operational Attention Alerts */}
            {pipelines &&
              (pipelines.summary.ambiguousChunksCount > 0 ||
                pipelines.summary.expiredSessionAccountsCount > 0 ||
                pipelines.summary.rateLimitedChunksCount > 0) && (
                <div className="space-y-2">
                  {pipelines.summary.ambiguousChunksCount > 0 && (
                    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-sm text-red-900">
                      <span>
                        <strong>Action Required:</strong> {pipelines.summary.ambiguousChunksCount}{" "}
                        ambiguous transfer chunk(s) require manual Owner balance reconciliation before resuming.
                      </span>
                      <Link href="/owner/orders">
                        <Button size="sm" variant="danger">
                          Resolve Ambiguous Transfers
                        </Button>
                      </Link>
                    </div>
                  )}
                  {pipelines.summary.expiredSessionAccountsCount > 0 && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-sm text-amber-900">
                      <span>
                        <strong>Session Expired:</strong> {pipelines.summary.expiredSessionAccountsCount}{" "}
                        LagosLife account(s) need session reconnection.
                      </span>
                      <Link href="/owner/inventory">
                        <Button size="sm" variant="secondary">
                          Reconnect Sessions
                        </Button>
                      </Link>
                    </div>
                  )}
                  {pipelines.summary.rateLimitedChunksCount > 0 && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                      <strong>Rate Limit Backoff (429):</strong>{" "}
                      {pipelines.summary.rateLimitedChunksCount} chunk(s) hit LagosLife 429 rate limits
                      and are queued for safe post-cooldown retry.
                    </div>
                  )}
                </div>
              )}

            {conflictsCount > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-sm text-amber-900">
                <span>{conflictsCount} pending attribution conflict(s) require Owner resolution.</span>
                <Link href="/owner/partners">
                  <Button size="sm" variant="secondary">
                    Review Conflicts
                  </Button>
                </Link>
              </div>
            )}

            {/* Worker, Queue & Pipeline Status Bar */}
            {pipelines && (
              <Card title="Worker & Multi-Pipeline Health">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 text-sm">
                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="text-xs text-slate-500">Live Sending Switch</p>
                    <div className="mt-1">
                      <StatusBadge
                        label={pipelines.disbursementEnabled ? "ENABLED" : "SAFETY LOCKED (FALSE)"}
                        tone={pipelines.disbursementEnabled ? "success" : "warning"}
                      />
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="text-xs text-slate-500">Background Worker</p>
                    <div className="mt-1 flex items-center gap-2">
                      <StatusBadge
                        label={pipelines.workerHeartbeat.alive ? "ONLINE" : "OFFLINE"}
                        tone={pipelines.workerHeartbeat.alive ? "success" : "danger"}
                      />
                    </div>
                    {pipelines.workerHeartbeat.lastHeartbeatAt && (
                      <p className="mt-1 text-[11px] text-slate-500">
                        Beat: {formatDateTime(pipelines.workerHeartbeat.lastHeartbeatAt)}
                      </p>
                    )}
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="text-xs text-slate-500">BullMQ Queue</p>
                    <p className="mt-1 font-mono-tabular font-semibold text-slate-900">
                      {pipelines.queueStats.connected
                        ? `${pipelines.queueStats.active} active / ${pipelines.queueStats.waiting} wait / ${pipelines.queueStats.delayed} delay`
                        : "Disconnected"}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="text-xs text-slate-500">Job States</p>
                    <p className="mt-1 font-mono-tabular font-semibold text-slate-900">
                      {pipelines.summary.runningJobs} run • {pipelines.summary.queuedJobs} queued •{" "}
                      {pipelines.summary.pausedJobs} paused
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="text-xs text-slate-500">Completed / Failed</p>
                    <p className="mt-1 font-mono-tabular font-semibold text-slate-900">
                      {pipelines.summary.completedJobs} done • {pipelines.summary.failedJobs} failed
                    </p>
                  </div>
                </div>
              </Card>
            )}

            {/* Five-Account Live Pipeline Status */}
            {pipelines && (
              <Card
                title="Five-Account Sending Pipelines"
                action={
                  <Link href="/owner/inventory">
                    <Button variant="secondary" size="sm">
                      Open Inventory Controls
                    </Button>
                  </Link>
                }
              >
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
                  {pipelines.accounts.map((acc) => (
                    <div
                      key={acc.id}
                      className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 text-xs space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold text-slate-900">{acc.slotCode}</span>
                        <StatusBadge
                          label={acc.connectionStatus}
                          tone={
                            acc.connectionStatus === "CONNECTED"
                              ? "success"
                              : acc.connectionStatus === "SESSION_EXPIRED"
                                ? "danger"
                                : "neutral"
                          }
                        />
                      </div>
                      <p className="text-slate-600 truncate">
                        @{acc.lagoslifeUsername ?? "unassigned"}
                      </p>
                      <div className="space-y-1 border-t border-slate-200 pt-2 font-mono-tabular">
                        <div className="flex justify-between">
                          <span className="text-slate-500">Synced:</span>
                          <span className="font-semibold text-slate-900">
                            {formatTrillions(acc.observedBalance)}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-500">Available:</span>
                          <span className="font-semibold text-emerald-700">
                            {formatTrillions(acc.netAvailableBalance)}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-500">Reserved:</span>
                          <span className="text-slate-700">
                            {formatTrillions(acc.reservedForOrders)}
                          </span>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5 border-t border-slate-200 pt-2">
                        <StatusBadge
                          label={acc.locked ? "SENDING NOW" : formatCooldownSec(acc.cooldownRemainingMs)}
                          tone={
                            acc.locked
                              ? "info"
                              : acc.cooldownRemainingMs > 0
                                ? "warning"
                                : "success"
                          }
                        />
                        {acc.activeChunkCount > 0 && (
                          <StatusBadge label={`${acc.activeChunkCount} pending`} tone="neutral" />
                        )}
                        {acc.rateLimitedChunkCount > 0 && (
                          <StatusBadge label={`${acc.rateLimitedChunkCount} 429`} tone="warning" />
                        )}
                        {acc.ambiguousChunkCount > 0 && (
                          <StatusBadge label={`${acc.ambiguousChunkCount} ambiguous`} tone="danger" />
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400">
                        Sync: {acc.lastSyncedAt ? formatDateTime(acc.lastSyncedAt) : "Never"}
                      </p>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Active & Recent Disbursement Jobs */}
            {pipelines && (
              <Card
                title="Active & Recent Disbursement Jobs"
                action={
                  <Link href="/owner/orders">
                    <Button variant="secondary" size="sm">
                      Manage Jobs in Orders
                    </Button>
                  </Link>
                }
              >
                {pipelines.jobs.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    No disbursement jobs authorized yet.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {pipelines.jobs.slice(0, 10).map((job) => (
                      <div
                        key={job.id}
                        className="py-3 flex flex-wrap items-center justify-between gap-3 text-sm"
                      >
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono-tabular font-semibold text-slate-900">
                              {job.orderNumber ?? job.orderId.slice(0, 8)}
                            </span>
                            <StatusBadge label={job.status} tone={jobTone(job.status)} />
                            {job.ambiguousChunks > 0 && (
                              <StatusBadge
                                label={`${job.ambiguousChunks} AMBIGUOUS`}
                                tone="danger"
                              />
                            )}
                            {job.rateLimitedChunks > 0 && (
                              <StatusBadge
                                label={`${job.rateLimitedChunks} RATE-LIMITED`}
                                tone="warning"
                              />
                            )}
                          </div>
                          <p className="mt-0.5 text-xs text-slate-500">
                            Recipient: @{job.recipientLagoslifeUsername ?? "—"} • Accounts:{" "}
                            {job.allocatedSlotCodes.join(", ") || "—"}
                          </p>
                        </div>
                        <div className="text-right font-mono-tabular">
                          <p className="font-semibold text-slate-900">
                            {formatTrillions(job.deliveredAmount)} / {formatTrillions(job.totalAmount)}
                          </p>
                          <p className="text-xs text-slate-500">
                            {job.completedChunks}/{job.totalChunks} chunks ({job.progressPercent}%)
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}

            {/* Recent Marketplace Orders */}
            <Card
              title="Recent Marketplace Orders"
              action={
                <Link href="/owner/orders">
                  <Button variant="secondary" size="sm">
                    View All Orders
                  </Button>
                </Link>
              }
            >
              {orders.length === 0 ? (
                <p className="text-sm text-slate-500">No orders placed yet.</p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {orders.map((ord) => (
                    <div
                      key={ord.id}
                      className="py-3 flex flex-wrap items-center justify-between gap-2 text-sm"
                    >
                      <div>
                        <p className="font-mono-tabular font-semibold text-slate-900">
                          {ord.orderNumber}
                        </p>
                        <p className="text-xs text-slate-500">
                          {ord.customer?.fullName ?? "Customer"} • {formatDateTime(ord.createdAt)}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-mono-tabular font-semibold text-slate-900">
                          {formatNaira(ord.fiatAmountKobo)}
                        </span>
                        <OrderStatusBadge status={ord.status} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </OwnerShell>
  );
}
