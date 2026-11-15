"use client";

import { useCallback, useEffect, useState } from "react";
import { ONE_TRILLION } from "@bigola/shared";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { formatDateTime, formatNaira, formatTrillions } from "@/lib/format";
import { OpsShell } from "@/components/OpsShell";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { OrderStatusBadge } from "@/components/ui/Badge";
import { SlideOver } from "@/components/ui/SlideOver";

interface OpsOrderRow {
  id: string;
  orderNumber: string;
  status: string;
  recipientLagoslifeUsername: string;
  gameAmountRequested: string;
  fulfilledAmount: string;
  fiatAmountKobo: string;
  customer: { fullName: string };
  createdAt: string;
}

interface SlotRow {
  id: string;
  slotCode: string;
  netAvailableBalance: string;
}

export default function OpsOrdersPage() {
  const { user } = useAuth();
  const [orders, setOrders] = useState<OpsOrderRow[]>([]);
  const [slots, setSlots] = useState<SlotRow[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<OpsOrderRow | null>(null);
  const [sourceGameAccountId, setSourceGameAccountId] = useState("");
  const [deliveredTrillions, setDeliveredTrillions] = useState("10");
  const [externalReference, setExternalReference] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ordRes, invRes] = await Promise.all([
        apiRequest<{ orders: OpsOrderRow[] }>("/ops/orders"),
        apiRequest<{ slots: SlotRow[] }>("/ops/inventory"),
      ]);
      setOrders(ordRes.orders);
      setSlots(invRes.slots);
      if (invRes.slots.length > 0 && !sourceGameAccountId) {
        setSourceGameAccountId(invRes.slots[0]!.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load operations desk.");
    }
  }, [sourceGameAccountId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleConfirmFulfilment(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedOrder) return;
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const deliveredAmount = (BigInt(deliveredTrillions) * ONE_TRILLION).toString();
      const idempotencyKey = `ops-fulfil-${selectedOrder.id}-${Date.now()}`;
      await apiRequest(`/ops/orders/${selectedOrder.id}/confirm-fulfilment`, {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: JSON.stringify({
          sourceGameAccountId,
          deliveredAmount,
          externalReference,
          idempotencyKey,
          notes,
        }),
      });
      setSuccess(`Manual fulfilment confirmed for ${selectedOrder.orderNumber}.`);
      setSelectedOrder(null);
      setExternalReference("");
      setNotes("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to confirm manual fulfilment.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <OpsShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Operations Orders & Fulfilment</h1>
          <p className="text-sm text-slate-500">
            Track order status and record manual LagosLife deliveries when authorized (DISBURSEMENT_ENABLED=false).
          </p>
        </div>

        {!user?.canConfirmFulfilment && user?.role === "OPS_ADMIN" && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Your OPS_ADMIN account currently has read-only order & support access. Owner authorization is required to confirm manual fulfilment.
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {success}
          </div>
        )}

        <Card title="All Marketplace Orders">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                  <th className="py-2 pr-4">Order</th>
                  <th className="py-2 pr-4">Customer</th>
                  <th className="py-2 pr-4">Requested / Fulfilled</th>
                  <th className="py-2 pr-4">Fiat</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td className="py-2.5 pr-4">
                      <p className="font-mono font-semibold text-slate-900">{o.orderNumber}</p>
                      <p className="text-xs text-slate-500">{formatDateTime(o.createdAt)}</p>
                    </td>
                    <td className="py-2.5 pr-4">
                      <p className="font-medium text-slate-900">{o.customer.fullName}</p>
                      <p className="font-mono text-xs text-slate-500">
                        {o.recipientLagoslifeUsername}
                      </p>
                    </td>
                    <td className="py-2.5 pr-4 font-mono tabular-nums">
                      {formatTrillions(o.fulfilledAmount)} / {formatTrillions(o.gameAmountRequested)}
                    </td>
                    <td className="py-2.5 pr-4 font-mono tabular-nums">
                      {formatNaira(o.fiatAmountKobo)}
                    </td>
                    <td className="py-2.5 pr-4">
                      <OrderStatusBadge status={o.status} />
                    </td>
                    <td className="py-2.5">
                      {user?.canConfirmFulfilment &&
                        (o.status === "READY_FOR_FULFILMENT" ||
                          o.status === "PARTIALLY_FULFILLED") && (
                          <Button
                            size="sm"
                            onClick={() => {
                              setSelectedOrder(o);
                              const rem =
                                (BigInt(o.gameAmountRequested) - BigInt(o.fulfilledAmount)) /
                                ONE_TRILLION;
                              setDeliveredTrillions(rem.toString());
                            }}
                          >
                            Confirm Fulfilment
                          </Button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <SlideOver
          open={Boolean(selectedOrder)}
          onClose={() => setSelectedOrder(null)}
          title={selectedOrder ? `Manual Fulfilment — ${selectedOrder.orderNumber}` : ""}
        >
          {selectedOrder && (
            <form onSubmit={handleConfirmFulfilment} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Source Game Account
                </label>
                <select
                  value={sourceGameAccountId}
                  onChange={(e) => setSourceGameAccountId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
                >
                  {slots.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.slotCode} (Net Avail: {formatTrillions(s.netAvailableBalance)})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Delivered Amount (Trillions)
                </label>
                <input
                  type="number"
                  min={1}
                  value={deliveredTrillions}
                  onChange={(e) => setDeliveredTrillions(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  LagosLife Transfer Reference
                </label>
                <input
                  value={externalReference}
                  onChange={(e) => setExternalReference(e.target.value)}
                  required
                  minLength={3}
                  placeholder="Unique manual transfer reference"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Notes</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <Button type="submit" disabled={submitting}>
                {submitting ? 'Recording...' : 'Record Manual Fulfilment'}
              </Button>
            </form>
          )}
        </SlideOver>
      </div>
    </OpsShell>
  );
}
