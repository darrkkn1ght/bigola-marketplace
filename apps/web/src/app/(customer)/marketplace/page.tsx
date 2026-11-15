"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ONE_TRILLION } from "@bigola/shared";
import { apiRequest } from "@/lib/api";
import { captureReferralFromUrl } from "@/lib/referral";
import { formatNaira, formatTrillions } from "@/lib/format";
import { CustomerShell } from "@/components/CustomerShell";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/Badge";
import { SkeletonCard } from "@/components/ui/Skeleton";

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
    void captureReferralFromUrl();
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
            <h1 className="font-display text-2xl font-bold text-[#0B1324]">
              Buy LagosLife Currency
            </h1>
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
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <div className="grid gap-6 xl:grid-cols-12">
            <div className="xl:col-span-7">
              <SkeletonCard rows={4} />
            </div>
            <div className="xl:col-span-5">
              <SkeletonCard rows={3} />
            </div>
          </div>
        ) : (
          <div className="grid gap-6 xl:grid-cols-12 items-start">
            <div className="xl:col-span-7 min-w-0 space-y-6">
              <Card
                title="Bulk Currency Calculator"
                subtitle={`Rate: ${formatNaira(pricePerT)} per 1T • Minimum ${minTrillions}T • 1T increments`}
              >
                <form onSubmit={handlePlaceOrder} className="space-y-5">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2.5">
                      Quick Select Quantity
                    </label>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                      {[10, 20, 50, 100].map((preset) => {
                        const active = trillions === preset;
                        return (
                          <button
                            key={preset}
                            type="button"
                            onClick={() => setTrillions(preset)}
                            className={`rounded-xl border px-3 py-2.5 text-left transition-all duration-150 cursor-pointer ${
                              active
                                ? "border-[#059669] bg-emerald-50/80 ring-1 ring-emerald-500/30"
                                : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
                            }`}
                          >
                            <span
                              className={`font-display block text-sm font-bold tabular-nums ${
                                active ? "text-[#059669]" : "text-[#0B1324]"
                              }`}
                            >
                              {preset}T
                            </span>
                            <span className="mt-0.5 block font-mono-tabular text-[11px] text-slate-500">
                              {formatNaira(BigInt(preset) * pricePerT)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                      Custom Quantity in Trillions (T)
                    </label>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setTrillions((prev) => Math.max(minTrillions, (prev || minTrillions) - 1))}
                        className="h-11 w-11 shrink-0 rounded-lg border border-slate-300 bg-white text-base font-bold text-[#0B1324] hover:bg-slate-50 cursor-pointer"
                        aria-label="Decrease quantity"
                      >
                        −
                      </button>
                      <input
                        type="number"
                        min={minTrillions}
                        step={1}
                        required
                        className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3.5 font-mono-tabular text-base font-semibold text-[#0B1324] focus:border-[#059669] focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                        value={trillions}
                        onChange={(e) => setTrillions(Number(e.target.value))}
                      />
                      <button
                        type="button"
                        onClick={() => setTrillions((prev) => (prev || minTrillions) + 1)}
                        className="h-11 w-11 shrink-0 rounded-lg border border-slate-300 bg-white text-base font-bold text-[#0B1324] hover:bg-slate-50 cursor-pointer"
                        aria-label="Increase quantity"
                      >
                        +
                      </button>
                    </div>
                    {!validQuantity && (
                      <p className="mt-1.5 text-xs font-medium text-red-600">
                        Please enter a whole number of at least {minTrillions}T.
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                      Recipient LagosLife Username
                    </label>
                    <input
                      type="text"
                      required
                      minLength={2}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-[#0B1324] focus:border-[#059669] focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                      placeholder="Enter exact LagosLife username"
                      value={recipientUsername}
                      onChange={(e) => setRecipientUsername(e.target.value)}
                    />
                    <p className="mt-1.5 text-xs text-slate-500">
                      Double-check spelling. Currency is allocated directly for this LagosLife account.
                    </p>
                  </div>

                  <Button
                    type="submit"
                    size="lg"
                    className="w-full py-3"
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
                        <div
                          key={pkg.id}
                          className="rounded-xl border border-slate-200 bg-slate-50/60 p-4"
                        >
                          <p className="font-display font-bold text-[#0B1324]">{pkg.name}</p>
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

            <div className="xl:col-span-5 min-w-0">
              <div className="xl:sticky xl:top-24 rounded-2xl border border-[#162340] bg-[#0B1324] p-5 sm:p-6 text-white shadow-lg">
                <div className="flex items-center justify-between border-b border-white/10 pb-3.5">
                  <h2 className="font-display text-base font-bold text-white">Order Summary</h2>
                  <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300 border border-emerald-500/30">
                    30m Hold
                  </span>
                </div>

                <dl className="mt-4 space-y-3 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-slate-400">Order Type</dt>
                    <dd className="font-semibold text-white">Bulk Currency</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">Quantity</dt>
                    <dd className="font-mono-tabular font-semibold text-white">
                      {validQuantity ? `${trillions}T` : "—"}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">Unit Rate</dt>
                    <dd className="font-mono-tabular text-slate-200">{formatNaira(pricePerT)} / 1T</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">Recipient</dt>
                    <dd className="font-medium text-slate-200 truncate max-w-[180px]">
                      {recipientUsername.trim() || "Not entered"}
                    </dd>
                  </div>
                  <div className="border-t border-white/10 pt-4 flex flex-wrap justify-between items-baseline gap-2">
                    <dt className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Total to Transfer
                    </dt>
                    <dd className="font-display text-xl sm:text-2xl font-extrabold text-emerald-400 tabular-nums">
                      {validQuantity ? formatNaira(totalKobo) : "—"}
                    </dd>
                  </div>
                </dl>

                <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.04] p-4 text-xs text-slate-300 space-y-1.5">
                  <p className="font-semibold text-white">What happens next?</p>
                  <p>1. Your stock is reserved for 30 minutes.</p>
                  <p>2. You&apos;ll see the OPay account details and your unique payment reference.</p>
                  <p>3. Transfer via OPay and submit your bank reference for verification.</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </CustomerShell>
  );
}
