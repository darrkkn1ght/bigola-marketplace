"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/Badge";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";

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
  const { pushToast } = useToast();

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
      pushToast({ title: "Support ticket opened", tone: "success" });
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
      pushToast({ title: isInternal ? "Internal note added" : "Reply sent", tone: "success" });
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
      pushToast({ title: `Ticket updated to ${nextStatus.replaceAll("_", " ")}`, tone: "success" });
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
        <Card
          title="Open a Support Request or Order Dispute"
          subtitle="Direct escalation to Big Ola operations with full order and transfer context."
        >
          <form onSubmit={handleCreateTicket} className="grid gap-4 md:grid-cols-2">
            {mode === "PARTNER" && (
              <div>
                <label className="block text-xs font-semibold text-[#0B1324] mb-1.5">
                  Attributed Customer ID (UUID)
                </label>
                <input
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  required
                  placeholder="Customer UUID"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#0B1324] focus:outline-none focus:ring-2 focus:ring-[#0B1324]/10"
                />
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold text-[#0B1324] mb-1.5">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#0B1324] focus:outline-none focus:ring-2 focus:ring-[#0B1324]/10"
              >
                <option value="PAYMENT_COMPLAINT">Payment Complaint</option>
                <option value="ORDER_DISPUTE">Order Dispute</option>
                <option value="ACCOUNT_ISSUE">Account Issue</option>
                <option value="GENERAL">General Inquiry</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#0B1324] mb-1.5">
                Priority
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#0B1324] focus:outline-none focus:ring-2 focus:ring-[#0B1324]/10"
              >
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
                <option value="URGENT">Urgent</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#0B1324] mb-1.5">
                Order ID (optional UUID)
              </label>
              <input
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
                placeholder="Optional Order UUID"
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#0B1324] focus:outline-none focus:ring-2 focus:ring-[#0B1324]/10"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-semibold text-[#0B1324] mb-1.5">Subject</label>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
                minLength={3}
                placeholder="Short summary of your issue"
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#0B1324] focus:outline-none focus:ring-2 focus:ring-[#0B1324]/10"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-semibold text-[#0B1324] mb-1.5">Details</label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                required
                minLength={3}
                rows={3}
                placeholder="Provide transfer reference, amount, or order context..."
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#0B1324] focus:outline-none focus:ring-2 focus:ring-[#0B1324]/10"
              />
            </div>
            <div className="md:col-span-2">
              <Button type="submit" disabled={submitting}>
                {submitting ? "Submitting..." : "Submit Support Request"}
              </Button>
            </div>
          </form>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <Card title="Tickets" subtitle={`${tickets.length} conversation${tickets.length === 1 ? "" : "s"}`} className="lg:col-span-2">
          {loading ? (
            <div className="space-y-3">
              <SkeletonCard />
              <SkeletonCard />
            </div>
          ) : tickets.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 p-6 text-center">
              <p className="font-display text-sm font-semibold text-[#0B1324]">No support tickets yet</p>
              <p className="mt-1 text-xs text-slate-500">
                Any payment or delivery questions opened above will appear here.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {tickets.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelected(t)}
                  className={`w-full text-left p-3 rounded-xl border transition-all ${
                    selected?.id === t.id
                      ? "border-[#0B1324] bg-[#0B1324]/[0.03] shadow-xs"
                      : "border-slate-200/80 bg-white hover:border-slate-300 hover:bg-slate-50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono-tabular text-xs font-semibold text-[#0B1324]">
                      {t.ticketNumber}
                    </span>
                    <StatusBadge
                      label={t.status.replaceAll("_", " ")}
                      tone={
                        t.status === "RESOLVED" || t.status === "CLOSED"
                          ? "success"
                          : t.status === "OPEN"
                          ? "warning"
                          : "info"
                      }
                    />
                  </div>
                  <p className="mt-1.5 text-sm font-semibold text-[#0B1324] truncate">{t.subject}</p>
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
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 p-8 text-center">
              <p className="font-display text-sm font-semibold text-[#0B1324]">Select a ticket</p>
              <p className="mt-1 text-xs text-slate-500">
                Choose a ticket from the list to view messages, resolutions, and reply.
              </p>
            </div>
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
