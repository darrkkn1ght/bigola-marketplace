"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiRequest } from "@/lib/api";
import { formatDateTime, formatNaira, formatTrillions } from "@/lib/format";
import { CustomerShell } from "@/components/CustomerShell";
import { Card } from "@/components/ui/Card";
import { OrderStatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

interface CustomerOrder {
  id: string;
  orderNumber: string;
  paymentReference: string;
  gameAmountRequested: string;
  fiatAmountKobo: string;
  status: string;
  recipientLagoslifeUsername: string;
  expiresAt: string | null;
  createdAt: string;
}

export default function CustomerOrdersPage() {
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiRequest<{ orders: CustomerOrder[] }>("/customer/orders")
      .then((res) => setOrders(res.orders))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <CustomerShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">My Orders</h1>
            <p className="mt-1 text-sm text-slate-600">
              View OPay payment instructions, submit transfer proof, and track verification progress.
            </p>
          </div>
          <Link href="/marketplace">
            <Button>New Order</Button>
          </Link>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <Card>
          {loading ? (
            <p className="text-sm text-slate-500">Loading your orders…</p>
          ) : orders.length === 0 ? (
            <div className="py-8 text-center space-y-3">
              <p className="text-sm text-slate-600">You haven&apos;t placed any orders yet.</p>
              <Link href="/marketplace">
                <Button size="sm">Buy Currency</Button>
              </Link>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {orders.map((ord) => (
                <div
                  key={ord.id}
                  className="py-4 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className="font-mono-tabular text-sm font-semibold text-slate-900">
                        {ord.orderNumber}
                      </span>
                      <OrderStatusBadge status={ord.status} />
                    </div>
                    <p className="text-xs text-slate-600">
                      <span className="font-mono-tabular font-medium text-slate-900">
                        {formatTrillions(ord.gameAmountRequested)}
                      </span>{" "}
                      •{" "}
                      <span className="font-mono-tabular font-medium text-slate-900">
                        {formatNaira(ord.fiatAmountKobo)}
                      </span>{" "}
                      • Recipient: <span className="font-medium">{ord.recipientLagoslifeUsername}</span>
                    </p>
                    <p className="text-[11px] text-slate-400">
                      Ref: <span className="font-mono-tabular">{ord.paymentReference}</span> • Placed{" "}
                      {formatDateTime(ord.createdAt)}
                    </p>
                  </div>

                  <Link href={`/marketplace/orders/${ord.id}`}>
                    <Button variant="secondary" size="sm">
                      {ord.status === "AWAITING_PAYMENT" ? "Pay & Submit Proof" : "View Status"}
                    </Button>
                  </Link>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </CustomerShell>
  );
}
