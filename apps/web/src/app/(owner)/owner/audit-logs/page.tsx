"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { OwnerShell } from "@/components/OwnerShell";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

interface AuditRow {
  id: string;
  actionType: string;
  targetEntity: string;
  targetId: string | null;
  beforeState: unknown;
  afterState: unknown;
  reason: string | null;
  ipAddress: string | null;
  actor: { id: string; email: string; role: string } | null;
  createdAt: string;
}

export default function OwnerAuditLogsPage() {
  const [logs, setLogs] = useState<AuditRow[]>([]);
  const [actionType, setActionType] = useState("");
  const [targetEntity, setTargetEntity] = useState("");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (actionType.trim()) params.set("actionType", actionType.trim());
    if (targetEntity.trim()) params.set("targetEntity", targetEntity.trim());
    if (search.trim()) params.set("search", search.trim());
    params.set("limit", "100");
    try {
      const res = await apiRequest<{ logs: AuditRow[] }>(`/owner/audit-logs?${params.toString()}`);
      setLogs(res.logs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit logs.");
    }
  }, [actionType, targetEntity, search]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <OwnerShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Operational Audit Logs</h1>
          <p className="text-sm text-slate-500">
            Immutable record of administrative actions, manual fulfilments, refunds, and inventory syncs.
          </p>
        </div>

        <Card title="Filter Audit Trail">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void load();
            }}
            className="grid gap-3 md:grid-cols-4"
          >
            <input
              value={actionType}
              onChange={(e) => setActionType(e.target.value)}
              placeholder="Action type (e.g. REFUND)"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              value={targetEntity}
              onChange={(e) => setTargetEntity(e.target.value)}
              placeholder="Target entity (e.g. orders)"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search reason or action..."
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <Button type="submit">Apply Filters</Button>
          </form>
        </Card>

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        )}

        <Card title={`Recent Audit Entries (${logs.length})`}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                  <th className="py-2 pr-4">Timestamp</th>
                  <th className="py-2 pr-4">Action</th>
                  <th className="py-2 pr-4">Actor</th>
                  <th className="py-2 pr-4">Target</th>
                  <th className="py-2 pr-4">Reason</th>
                  <th className="py-2">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {logs.map((l) => (
                  <tr key={l.id} className="align-top">
                    <td className="py-2.5 pr-4 text-xs text-slate-500 whitespace-nowrap">
                      {formatDateTime(l.createdAt)}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs font-semibold text-slate-800">
                      {l.actionType}
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-slate-600">
                      {l.actor ? `${l.actor.email} (${l.actor.role})` : "System"}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-slate-600">
                      {l.targetEntity}
                      {l.targetId ? ` · ${l.targetId.slice(0, 8)}` : ""}
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-slate-700">{l.reason ?? "—"}</td>
                    <td className="py-2.5">
                      <button
                        type="button"
                        onClick={() => setExpandedId(expandedId === l.id ? null : l.id)}
                        className="text-xs font-medium text-indigo-600 hover:underline"
                      >
                        {expandedId === l.id ? "Hide JSON" : "Inspect"}
                      </button>
                      {expandedId === l.id && (
                        <pre className="mt-2 max-w-md overflow-x-auto rounded-lg bg-slate-900 p-2 text-[11px] text-slate-100">
                          {JSON.stringify({ before: l.beforeState, after: l.afterState }, null, 2)}
                        </pre>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </OwnerShell>
  );
}
