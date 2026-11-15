"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ONE_TRILLION } from "@bigola/shared";
import { apiRequest } from "@/lib/api";
import { formatNaira, formatTrillions } from "@/lib/format";
import { CustomerShell } from "@/components/CustomerShell";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/Badge";

interface BulkPricingInfo {
  priceKoboPerTrillion: string;
  minBulkGameAmount: string;
  enabled: boolean;
}

interface RetailPricingInfo {
  status: string;
  packages: Array<{ id: string; name: string; gameAmount: string; fiatKobo: string; enabled: boolean }>;
}

interface CatalogResponse {
  bulk?: BulkPricingInfo;
  bulkPricing?: BulkPricingInfo;
  retail?: RetailPricingInfo;
  retailPricing?: RetailPricingInfo;
  availability?: {
    reservableAvailable?: string;
    totalReservableAvailable?: string;
    isFresh?: boolean;
    activeFreshSlotCount?: number;
    maxAgeMinutes?: number;
  };
}

export default function MarketplacePage() {
  const router = useRouter();
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [trillions, setTrillions] = useState(10);
  const [recipientUsername, setRecipientUsername] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [catRes, profRes] = await Promise.all([
        apiRequest<CatalogResponse>("/catalog/pricing"),
        apiRequest<{ profile: { lagoslifeUsername: string | null } }>("/customer/profile").catch(
          () => null
        ),
      ]);
      setCatalog(catRes);
      if (profRes?.profile?.lagoslifeUsername) {
        setRecipientUsername((prev) => prev || profRes.profile.lagoslifeUsername || "");
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const bulk = catalog?.bulk ?? catalog?.bulkPricing;
  const retail = catalog?.retail ?? catalog?.retailPricing;
  const reservableAvailable =
    catalog?.availability?.reservableAvailable ??
    catalog?.availability?.totalReservableAvailable ??
    "0";
  const isFresh =
    catalog?.availability?.isFresh ??
    (catalog?.availability?.activeFreshSlotCount ?? 0) > 0;

  const minTrillions = bulk
    ? Number(BigInt(bulk.minBulkGameAmount) / ONE_TRILLION)
    : 10;
  const pricePerT = bulk ? BigInt(bulk.priceKoboPerTrillion) : 100_000n;
  const validQuantity = Number.isInteger(trillions) && trillions >= minTrillions;
  const totalKobo = validQuantity ? BigInt(trillions) * pricePerT : 0n;

  async function handlePlaceOrder(e: React.FormEvent) {
    e.preventDefault();
    if (!validQuantity) {
      setError(`Minimum bulk order is ${minTrillions}T in 1T increments.`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const idempotencyKey =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `ord-${Date.now()}`;

      const res = await apiRequest<{ order: { id: string } }>("/orders", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          orderType: "BULK",
          gameAmount: (BigInt(trillions) * ONE_TRILLION).toString(),
          recipientLagoslifeUsername: recipientUsername.trim(),
        }),
      });
      router.push(`/marketplace/orders/${res.order.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <CustomerShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Buy LagosLife Currency</h1>
            <p className="mt-1 text-sm text-slate-600">
              Reserve currency from verified stock and pay securely via OPay bank transfer.
            </p>
          </div>
          {catalog && (
            <StatusBadge
              label={
                isFresh
                  ? `${formatTrillions(reservableAvailable)} Available`
                  : "Stock Sync Pending"
              }
              tone={isFresh ? "success" : "warning"}
            />
          )}
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <Card>
            <p className="text-sm text-slate-500">Loading live pricing and stock availability…</p>
          </Card>
        ) : (
          <div className="grid gap-6 lg:grid-cols-12">
            <div className="lg:col-span-7 space-y-6">
              <Card
                title="Bulk Currency Calculator"
                subtitle={`Rate: ${formatNaira(pricePerT)} per 1T • Minimum ${minTrillions}T • 1T increments`}
              >
                <form onSubmit={handlePlaceOrder} className="space-y-5">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-2">
                      Quick Select Quantity
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {[10, 20, 50, 100].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => setTrillions(preset)}
                          className={`rounded-lg border px-3.5 py-2 text-xs font-semibold tabular-nums transition-colors cursor-pointer ${
                            trillions === preset
                              ? "border-[#059669] bg-emerald-50 text-[#059669]"
                              : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                          }`}
                        >
                          {preset}T ({formatNaira(BigInt(preset) * pricePerT)})
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Quantity in Trillions (T)
                    </label>
                    <input
                      type="number"
                      min={minTrillions}
                      step={1}
                      required
                      className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 font-mono-tabular text-base text-slate-900 focus:border-[#059669] focus:outline-none"
                      value={trillions}
                      onChange={(e) => setTrillions(Number(e.target.value))}
                    />
                    {!validQuantity && (
                      <p className="mt-1 text-xs text-red-600">
                        Please enter a whole number of at least {minTrillions}T.
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Recipient LagosLife Username
                    </label>
                    <input
                      type="text"
                      required
                      minLength={2}
                      className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#059669] focus:outline-none"
                      placeholder="Enter exact LagosLife username"
                      value={recipientUsername}
                      onChange={(e) => setRecipientUsername(e.target.value)}
                    />
                    <p className="mt-1 text-xs text-slate-500">
                      Double-check spelling. Currency is allocated for this LagosLife account.
                    </p>
                  </div>

                  <Button
                    type="submit"
                    size="lg"
                    className="w-full"
                    disabled={submitting || !validQuantity || !isFresh}
                  >
                    {submitting
                      ? "Reserving Stock…"
                      : !isFresh
                        ? "Stock Temporarily Paused (Sync Pending)"
                        : `Reserve ${trillions}T & View OPay Details`}
                  </Button>
                </form>
              </Card>

              <Card title="Retail Packages">
                {retail?.status === "CONFIGURED" && retail.packages.length > 0 ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {retail.packages
                      .filter((p) => p.enabled)
                      .map((pkg) => (
                        <div key={pkg.id} className="rounded-lg border border-slate-200 p-4">
                          <p className="font-semibold text-slate-900">{pkg.name}</p>
                          <p className="text-xs text-slate-500">{formatTrillions(pkg.gameAmount)}</p>
                          <p className="mt-2 font-mono-tabular text-sm font-bold text-[#059669]">
                            {formatNaira(pkg.fiatKobo)}
                          </p>
                        </div>
                      ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">
                    Retail packages are not configured yet. Bulk orders starting at {minTrillions}T are available above.
                  </p>
                )}
              </Card>
            </div>

            <div className="lg:col-span-5">
              <Card title="Order Summary" className="sticky top-24">
                <dl className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-slate-500">Order Type</dt>
                    <dd className="font-medium text-slate-900">Bulk Currency</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-500">Quantity</dt>
                    <dd className="font-mono-tabular font-medium text-slate-900">
                      {validQuantity ? `${trillions}T` : "—"}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-500">Unit Rate</dt>
                    <dd className="font-mono-tabular text-slate-900">{formatNaira(pricePerT)} / 1T</dd>
                  </div>
                  <div className="border-t border-slate-200 pt-3 flex justify-between items-baseline">
                    <dt className="font-semibold text-slate-900">Total to Transfer</dt>
                    <dd className="font-mono-tabular text-2xl font-bold text-[#059669]">
                      {validQuantity ? formatNaira(totalKobo) : "—"}
                    </dd>
                  </div>
                </dl>

                <div className="mt-5 rounded-lg bg-slate-50 border border-slate-200 p-3.5 text-xs text-slate-600 space-y-1.5">
                  <p className="font-semibold text-slate-800">What happens next?</p>
                  <p>1. Your stock is reserved for 30 minutes.</p>
                  <p>2. You&apos;ll see the OPay account details and your unique payment reference.</p>
                  <p>3. Transfer via OPay and submit your bank reference for verification.</p>
                </div>
              </Card>
            </div>
          </div>
        )}
      </div>
    </CustomerShell>
  );
}
