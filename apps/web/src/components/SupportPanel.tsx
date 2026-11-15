"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/Badge";

interface TicketMessage {
  id: string;
  body: string;
  isInternal?: boolean;
  authorRole?: string;
  author?: { role: string; email?: string };
  authorEmail?: string;
  createdAt: string;
}

interface TicketSummary {
  id: string;
  ticketNumber: string;
  category: string;
  status: string;
  priority: string;
  subject: string;
  resolutionSummary?: string | null;
  customer?: { id: string; fullName: string };
  order?: { id: string; orderNumber: string; status: string } | null;
  messages: TicketMessage[];
  createdAt: string;
}

export function SupportPanel({
  mode,
}: {
  mode: "CUSTOMER" | "PARTNER" | "OWNER" | "OPS";
}) {
  const isStaff = mode === "OWNER" || mode === "OPS";
  const basePath =
    mode === "CUSTOMER"
      ? "/customer/support/tickets"
      : mode === "PARTNER"
      ? "/partner/support/tickets"
      : "/ops/support/tickets";

  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [selected, setSelected] = useState<TicketSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create ticket form (customer/partner)
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState("PAYMENT_COMPLAINT");
  const [priority, setPriority] = useState("MEDIUM");
  const [orderId, setOrderId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Reply / status update
  const [replyBody, setReplyBody] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [nextStatus, setNextStatus] = useState("IN_REVIEW");
  const [resolutionSummary, setResolutionSummary] = useState("");

  const loadTickets = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ tickets: TicketSummary[] }>(basePath);
      setTickets(res.tickets);
      if (selected) {
        const updated = res.tickets.find((t) => t.id === selected.id) ?? null;
        setSelected(updated);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load support tickets.");
    } finally {
      setLoading(false);
    }
  }, [basePath, selected]);

  useEffect(() => {
    void loadTickets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePath]);

  async function handleCreateTicket(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiRequest(basePath, {
        method: "POST",
        body: JSON.stringify({
          ...(mode === "PARTNER" ? { customerId } : {}),
          ...(orderId.trim() ? { orderId: orderId.trim() } : {}),
          category,
          priority,
          subject,
          body,
        }),
      });
      setSubject("");
      setBody("");
      setOrderId("");
      await loadTickets();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create ticket.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSendReply(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !replyBody.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiRequest(`${basePath}/${selected.id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          body: replyBody.trim(),
          ...(isStaff ? { isInternal } : {}),
        }),
      });
      setReplyBody("");
      setIsInternal(false);
      await loadTickets();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post reply.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStatusUpdate(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !isStaff) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiRequest(`${basePath}/${selected.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({
          status: nextStatus,
          ...(resolutionSummary.trim() ? { resolutionSummary: resolutionSummary.trim() } : {}),
        }),
      });
      setResolutionSummary("");
      await loadTickets();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update ticket status.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {(mode === "CUSTOMER" || mode === "PARTNER") && (
        <Card title="Open a Support Request or Order Dispute">
          <form onSubmit={handleCreateTicket} className="grid gap-3 md:grid-cols-2">
            {mode === "PARTNER" && (
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Attributed Customer ID (UUID)
                </label>
                <input
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  required
                  placeholder="Customer UUID"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
              >
                <option value="PAYMENT_COMPLAINT">Payment Complaint</option>
                <option value="ORDER_DISPUTE">Order Dispute</option>
                <option value="ACCOUNT_ISSUE">Account Issue</option>
                <option value="GENERAL">General Inquiry</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Priority
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
              >
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
                <option value="URGENT">Urgent</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Order ID (optional UUID)
              </label>
              <input
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
                placeholder="Optional Order UUID"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-600 mb-1">Subject</label>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
                minLength={3}
                placeholder="Short summary of your issue"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-600 mb-1">Details</label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                required
                minLength={3}
                rows={3}
                placeholder="Provide transfer reference, amount, or order context..."
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="md:col-span-2">
              <Button type="submit" disabled={submitting}>
                {submitting ? 'Submitting...' : 'Submit Support Request'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <Card title="Tickets" className="lg:col-span-2">
          {loading ? (
            <p className="text-sm text-slate-500">Loading tickets...</p>
          ) : tickets.length === 0 ? (
            <p className="text-sm text-slate-500">No support tickets yet.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {tickets.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelected(t)}
                  className={`w-full text-left py-3 px-2 rounded-lg transition-colors ${
                    selected?.id === t.id ? "bg-slate-100" : "hover:bg-slate-50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold text-slate-700">
                      {t.ticketNumber}
                    </span>
                    <StatusBadge
                      label={t.status}
                      tone={
                        t.status === "RESOLVED" || t.status === "CLOSED"
                          ? "success"
                          : t.status === "OPEN"
                          ? "warning"
                          : "info"
                      }
                    />
                  </div>
                  <p className="mt-1 text-sm font-medium text-slate-900 truncate">{t.subject}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {t.category.replaceAll("_", " ")} · {t.priority}
                    {t.order ? ` · Order ${t.order.orderNumber}` : ""}
                  </p>
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card
          title={selected ? `${selected.ticketNumber} — ${selected.subject}` : "Ticket Thread"}
          className="lg:col-span-3"
        >
          {!selected ? (
            <p className="text-sm text-slate-500">Select a ticket to view messages and updates.</p>
          ) : (
            <div className="space-y-4">
              {selected.resolutionSummary && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
                  <strong>Resolution:</strong> {selected.resolutionSummary}
                </div>
              )}

              <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                {selected.messages.map((m) => (
                  <div
                    key={m.id}
                    className={`rounded-lg border p-3 text-sm ${
                      m.isInternal
                        ? "border-amber-200 bg-amber-50"
                        : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                      <span className="font-semibold text-slate-700">
                        {m.author?.role ?? m.authorRole ?? "USER"}
                        {m.isInternal && " · INTERNAL STAFF NOTE"}
                      </span>
                      <span>{formatDateTime(m.createdAt)}</span>
                    </div>
                    <p className="text-slate-800 whitespace-pre-wrap">{m.body}</p>
                  </div>
                ))}
              </div>

              <form onSubmit={handleSendReply} className="space-y-2 border-t border-slate-100 pt-3">
                <textarea
                  value={replyBody}
                  onChange={(e) => setReplyBody(e.target.value)}
                  rows={2}
                  placeholder={isStaff && isInternal ? "Internal staff note (hidden from Customer & Partner)..." : "Write a reply..."}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {isStaff ? (
                    <label className="inline-flex items-center gap-2 text-xs font-medium text-amber-800">
                      <input
                        type="checkbox"
                        checked={isInternal}
                        onChange={(e) => setIsInternal(e.target.checked)}
                      />
                      Internal staff note only (hidden from Customer & Partner)
                    </label>
                  ) : (
                    <span />
                  )}
                  <Button type="submit" disabled={submitting}>
                    Send Message
                  </Button>
                </div>
              </form>

              {isStaff && (
                <form
                  onSubmit={handleStatusUpdate}
                  className="grid gap-2 border-t border-slate-100 pt-3 md:grid-cols-3"
                >
                  <select
                    value={nextStatus}
                    onChange={(e) => setNextStatus(e.target.value)}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
                  >
                    <option value="OPEN">OPEN</option>
                    <option value="IN_REVIEW">IN_REVIEW</option>
                    <option value="WAITING_CUSTOMER">WAITING_CUSTOMER</option>
                    <option value="RESOLVED">RESOLVED</option>
                    <option value="CLOSED">CLOSED</option>
                  </select>
                  <input
                    value={resolutionSummary}
                    onChange={(e) => setResolutionSummary(e.target.value)}
                    placeholder="Resolution summary (required for Resolved/Closed)"
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                  <Button type="submit" variant="secondary" disabled={submitting}>
                    Update Status
                  </Button>
                </form>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
