"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiRequest } from "@/lib/api";
import { formatDateTime, formatNaira, formatTrillions } from "@/lib/format";
import { CustomerShell } from "@/components/CustomerShell";
import { Card } from "@/components/ui/Card";
import { OrderStatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SkeletonCard } from "@/components/ui/Skeleton";

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
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-[#0B1324]">
              My Orders
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              View OPay payment instructions, submit transfer proof, and track verification progress.
            </p>
          </div>
          <Link href="/marketplace">
            <Button>New Order</Button>
          </Link>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        )}

        <Card>
          {loading ? (
            <div className="space-y-3">
              <SkeletonCard />
              <SkeletonCard />
            </div>
          ) : orders.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 py-10 px-6 text-center space-y-3">
              <p className="font-display text-base font-semibold text-[#0B1324]">
                No orders placed yet
              </p>
              <p className="text-sm text-slate-500">
                Use the bulk currency calculator to reserve LagosLife currency and receive OPay payment instructions.
              </p>
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
                      <span className="font-mono-tabular text-sm font-bold text-[#0B1324]">
                        {ord.orderNumber}
                      </span>
                      <OrderStatusBadge status={ord.status} />
                    </div>
                    <p className="text-xs text-slate-600">
                      <span className="font-mono-tabular font-semibold text-[#0B1324]">
                        {formatTrillions(ord.gameAmountRequested)}
                      </span>{" "}
                      ·{" "}
                      <span className="font-mono-tabular font-semibold text-[#059669]">
                        {formatNaira(ord.fiatAmountKobo)}
                      </span>{" "}
                      · Recipient:{" "}
                      <span className="font-semibold text-[#0B1324]">
                        @{ord.recipientLagoslifeUsername}
                      </span>
                    </p>
                    <p className="text-[11px] text-slate-400">
                      Ref: <span className="font-mono-tabular">{ord.paymentReference}</span> · Placed{" "}
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
