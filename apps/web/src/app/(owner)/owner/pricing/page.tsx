"use client";

import { useCallback, useEffect, useState } from "react";
import { calculateBulkOrderQuote, ONE_TRILLION } from "@bigola/shared";
import { apiRequest } from "@/lib/api";
import { formatNaira, formatTrillions } from "@/lib/format";
import { OwnerShell } from "@/components/OwnerShell";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";

interface BulkTierRow {
  minTrillions: string;
  priceNairaPerT: string;
  label: string;
}

interface BulkPricingInfo {
  priceKoboPerTrillion: string;
  minBulkGameAmount: string;
  maxBulkGameAmount?: string | null;
  bulkIncrementGameAmount?: string;
  promoDiscountBps?: number;
  promoLabel?: string | null;
  tiers?: Array<{ minGameAmount: string; priceKoboPerTrillion: string; label?: string }>;
  enabled: boolean;
}

interface RetailPackageRow {
  id: string;
  name: string;
  gameAmountBillions: string;
  priceNaira: string;
  promoPriceNaira: string;
  promoLabel: string;
  enabled: boolean;
}

interface RetailPricingInfo {
  status: "UNCONFIGURED" | "CONFIGURED";
  packages: Array<{
    id: string;
    name: string;
    gameAmount: string;
    fiatKobo: string;
    enabled: boolean;
    promoFiatKobo?: string | null;
    promoLabel?: string | null;
  }>;
}

interface PricingOverview {
  bulk?: BulkPricingInfo;
  bulkPricing?: BulkPricingInfo;
  retail?: RetailPricingInfo;
  retailPricing?: RetailPricingInfo;
}

const ONE_BILLION = 1_000_000_000n;

export default function OwnerPricingPage() {
  const [pricing, setPricing] = useState<PricingOverview | null>(null);
  const [priceNairaPerT, setPriceNairaPerT] = useState("1000");
  const [minTrillions, setMinTrillions] = useState("10");
  const [maxTrillions, setMaxTrillions] = useState("");
  const [incrementTrillions, setIncrementTrillions] = useState("1");
  const [promoDiscountPercent, setPromoDiscountPercent] = useState("0");
  const [promoLabel, setPromoLabel] = useState("");
  const [bulkTiers, setBulkTiers] = useState<BulkTierRow[]>([]);
  const [bulkEnabled, setBulkEnabled] = useState(true);
  const [bulkReason, setBulkReason] = useState("");

  const [retailStatus, setRetailStatus] = useState<"UNCONFIGURED" | "CONFIGURED">("UNCONFIGURED");
  const [retailPackages, setRetailPackages] = useState<RetailPackageRow[]>([]);
  const [retailReason, setRetailReason] = useState("");
  const [savingRetail, setSavingRetail] = useState(false);

  const [previewTrillions, setPreviewTrillions] = useState("25");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { pushToast } = useToast();

  const loadPricing = useCallback(async () => {
    try {
      const res = await apiRequest<PricingOverview>("/owner/pricing");
      setPricing(res);
      const bulk = res.bulk ?? res.bulkPricing;
      if (bulk) {
        setPriceNairaPerT((Number(BigInt(bulk.priceKoboPerTrillion)) / 100).toString());
        setMinTrillions((BigInt(bulk.minBulkGameAmount) / ONE_TRILLION).toString());
        setMaxTrillions(
          bulk.maxBulkGameAmount ? (BigInt(bulk.maxBulkGameAmount) / ONE_TRILLION).toString() : ""
        );
        setIncrementTrillions(
          bulk.bulkIncrementGameAmount
            ? (BigInt(bulk.bulkIncrementGameAmount) / ONE_TRILLION).toString()
            : "1"
        );
        setPromoDiscountPercent(
          bulk.promoDiscountBps ? (bulk.promoDiscountBps / 100).toString() : "0"
        );
        setPromoLabel(bulk.promoLabel ?? "");
        setBulkTiers(
          (bulk.tiers ?? []).map((t) => ({
            minTrillions: (BigInt(t.minGameAmount) / ONE_TRILLION).toString(),
            priceNairaPerT: (Number(BigInt(t.priceKoboPerTrillion)) / 100).toString(),
            label: t.label ?? "",
          }))
        );
        setBulkEnabled(bulk.enabled);
      }
      const ret = res.retail ?? res.retailPricing;
      if (ret) {
        setRetailStatus(ret.status);
        setRetailPackages(
          ret.packages.map((p) => ({
            id: p.id,
            name: p.name,
            gameAmountBillions: (BigInt(p.gameAmount) / ONE_BILLION).toString(),
            priceNaira: (Number(BigInt(p.fiatKobo)) / 100).toString(),
            promoPriceNaira: p.promoFiatKobo ? (Number(BigInt(p.promoFiatKobo)) / 100).toString() : "",
            promoLabel: p.promoLabel ?? "",
            enabled: p.enabled,
          }))
        );
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const retail = pricing?.retail ?? pricing?.retailPricing;

  useEffect(() => {
    void loadPricing();
  }, [loadPricing]);

  async function handleSaveBulk(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const promoBps = Math.max(0, Math.min(9000, Math.round(Number(promoDiscountPercent || "0") * 100)));
      await apiRequest("/owner/pricing/bulk", {
        method: "PUT",
        body: JSON.stringify({
          priceKoboPerTrillion: BigInt(Math.round(Number(priceNairaPerT) * 100)).toString(),
          minBulkGameAmount: (BigInt(minTrillions || "10") * ONE_TRILLION).toString(),
          maxBulkGameAmount: maxTrillions.trim()
            ? (BigInt(maxTrillions.trim()) * ONE_TRILLION).toString()
            : null,
          bulkIncrementGameAmount: (BigInt(incrementTrillions || "1") * ONE_TRILLION).toString(),
          promoDiscountBps: promoBps,
          promoLabel: promoLabel.trim() || null,
          tiers: bulkTiers
            .filter((t) => Number(t.minTrillions) > 0 && Number(t.priceNairaPerT) > 0)
            .map((t) => ({
              minGameAmount: (BigInt(t.minTrillions) * ONE_TRILLION).toString(),
              priceKoboPerTrillion: BigInt(Math.round(Number(t.priceNairaPerT) * 100)).toString(),
              label: t.label.trim() || undefined,
            })),
          enabled: bulkEnabled,
          reason: bulkReason.trim(),
        }),
      });
      setNotice("Bulk pricing updated. Existing orders retain their immutable pricing snapshots.");
      pushToast({ title: "Bulk pricing updated", tone: "success" });
      setBulkReason("");
      await loadPricing();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveRetail(e: React.FormEvent) {
    e.preventDefault();
    if (retailReason.trim().length < 3) {
      setError("Enter an audit reason (min 3 chars) before saving retail pricing.");
      return;
    }
    setSavingRetail(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest("/owner/pricing/retail", {
        method: "PUT",
        body: JSON.stringify({
          status: retailStatus,
          packages: retailPackages.map((p, idx) => ({
            id: p.id.trim() || `pkg-${idx + 1}`,
            name: p.name.trim() || `Package ${idx + 1}`,
            gameAmount: (BigInt(p.gameAmountBillions || "100") * ONE_BILLION).toString(),
            fiatKobo: BigInt(Math.round(Number(p.priceNaira || "0") * 100)).toString(),
            promoFiatKobo: p.promoPriceNaira.trim()
              ? BigInt(Math.round(Number(p.promoPriceNaira.trim()) * 100)).toString()
              : null,
            promoLabel: p.promoLabel.trim() || null,
            enabled: p.enabled,
          })),
          reason: retailReason.trim(),
        }),
      });
      setNotice("Retail pricing catalog updated. Existing orders keep their original snapshots.");
      pushToast({ title: "Retail pricing updated", tone: "success" });
      setRetailReason("");
      await loadPricing();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingRetail(false);
    }
  }

  let previewResult: { text: string; tone: "ok" | "err" } = { text: "Enter a quantity in T", tone: "ok" };
  try {
    const qtyT = BigInt(previewTrillions || "0");
    const quote = calculateBulkOrderQuote(qtyT * ONE_TRILLION, {
      priceKoboPerTrillion: BigInt(Math.round(Number(priceNairaPerT || "0") * 100)),
      minBulkGameAmount: BigInt(minTrillions || "10") * ONE_TRILLION,
      maxBulkGameAmount: maxTrillions.trim() ? BigInt(maxTrillions.trim()) * ONE_TRILLION : null,
      bulkIncrementGameAmount: BigInt(incrementTrillions || "1") * ONE_TRILLION,
      tiers: bulkTiers
        .filter((t) => Number(t.minTrillions) > 0 && Number(t.priceNairaPerT) > 0)
        .map((t) => ({
          minGameAmount: BigInt(t.minTrillions) * ONE_TRILLION,
          priceKoboPerTrillion: BigInt(Math.round(Number(t.priceNairaPerT) * 100)),
          label: t.label.trim() || undefined,
        })),
      promoDiscountBps: Math.max(0, Math.min(9000, Math.round(Number(promoDiscountPercent || "0") * 100))),
    });
    previewResult = {
      tone: "ok",
      text: `${formatNaira(quote.netFiatKobo.toString())} (${formatNaira(quote.unitPriceKoboPerTrillion.toString())}/T${
        quote.appliedTierLabel ? ` · Tier: ${quote.appliedTierLabel}` : ""
      }${quote.discountKobo > 0n ? ` · Promo saved ${formatNaira(quote.discountKobo.toString())}` : ""})`,
    };
  } catch (err) {
    previewResult = { tone: "err", text: (err as Error).message };
  }

  return (
    <OwnerShell>
      <div className="space-y-6 max-w-4xl">
        <div>
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-[#0B1324]">
            Pricing Management
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Configure bulk currency pricing. Existing orders keep immutable price snapshots at reservation time.
          </p>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {notice}
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Bulk Pricing, Tiers & Promotions">
            <form onSubmit={handleSaveBulk} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Base Price per 1T (₦)
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="0.01"
                    required
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular text-sm"
                    value={priceNairaPerT}
                    onChange={(e) => setPriceNairaPerT(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Increment Step (T)
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    required
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular text-sm"
                    value={incrementTrillions}
                    onChange={(e) => setIncrementTrillions(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Min Bulk Order (T)
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    required
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular text-sm"
                    value={minTrillions}
                    onChange={(e) => setMinTrillions(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Max Bulk Order (T, optional)
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    placeholder="No limit"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular text-sm"
                    value={maxTrillions}
                    onChange={(e) => setMaxTrillions(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Promo Discount (%)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="90"
                    step="0.5"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular text-sm"
                    value={promoDiscountPercent}
                    onChange={(e) => setPromoDiscountPercent(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Promo Label
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Weekend Promo"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    value={promoLabel}
                    onChange={(e) => setPromoLabel(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-700">Quantity-Based Bulk Tiers</span>
                  <button
                    type="button"
                    onClick={() =>
                      setBulkTiers((prev) => [
                        ...prev,
                        { minTrillions: "50", priceNairaPerT: priceNairaPerT, label: "50T+ Tier" },
                      ])
                    }
                    className="text-xs font-semibold text-indigo-600 hover:text-indigo-800"
                  >
                    + Add Tier
                  </button>
                </div>
                {bulkTiers.length === 0 ? (
                  <p className="text-xs text-slate-500">No volume tiers configured (flat base rate applies).</p>
                ) : (
                  bulkTiers.map((tier, idx) => (
                    <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                      <input
                        type="number"
                        min="1"
                        placeholder="Min T"
                        className="col-span-3 rounded border border-slate-300 bg-white px-2 py-1 text-xs font-mono-tabular"
                        value={tier.minTrillions}
                        onChange={(e) =>
                          setBulkTiers((prev) =>
                            prev.map((row, i) => (i === idx ? { ...row, minTrillions: e.target.value } : row))
                          )
                        }
                      />
                      <input
                        type="number"
                        min="1"
                        step="0.01"
                        placeholder="₦ / 1T"
                        className="col-span-4 rounded border border-slate-300 bg-white px-2 py-1 text-xs font-mono-tabular"
                        value={tier.priceNairaPerT}
                        onChange={(e) =>
                          setBulkTiers((prev) =>
                            prev.map((row, i) => (i === idx ? { ...row, priceNairaPerT: e.target.value } : row))
                          )
                        }
                      />
                      <input
                        type="text"
                        placeholder="Tier label"
                        className="col-span-4 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                        value={tier.label}
                        onChange={(e) =>
                          setBulkTiers((prev) =>
                            prev.map((row, i) => (i === idx ? { ...row, label: e.target.value } : row))
                          )
                        }
                      />
                      <button
                        type="button"
                        onClick={() => setBulkTiers((prev) => prev.filter((_, i) => i !== idx))}
                        className="col-span-1 text-xs font-bold text-rose-600 hover:text-rose-800"
                      >
                        ×
                      </button>
                    </div>
                  ))
                )}
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={bulkEnabled}
                  onChange={(e) => setBulkEnabled(e.target.checked)}
                />
                Bulk Orders Enabled
              </label>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Audit Reason (min 3 chars)
                </label>
                <input
                  type="text"
                  required
                  minLength={3}
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm"
                  placeholder="e.g. Standard bulk rate confirmation"
                  value={bulkReason}
                  onChange={(e) => setBulkReason(e.target.value)}
                />
              </div>
              <Button type="submit" variant="owner" disabled={saving}>
                {saving ? "Saving…" : "Save Bulk Pricing"}
              </Button>
            </form>
          </Card>

          <Card
            title="Retail Packages & Promotions"
            action={
              <StatusBadge
                label={retail?.status ?? retailStatus}
                tone={(retail?.status ?? retailStatus) === "CONFIGURED" ? "success" : "warning"}
              />
            }
          >
            <form onSubmit={handleSaveRetail} className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <select
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium"
                  value={retailStatus}
                  onChange={(e) =>
                    setRetailStatus(e.target.value === "CONFIGURED" ? "CONFIGURED" : "UNCONFIGURED")
                  }
                >
                  <option value="UNCONFIGURED">UNCONFIGURED (Hidden from buyers)</option>
                  <option value="CONFIGURED">CONFIGURED (Visible to buyers)</option>
                </select>
                <button
                  type="button"
                  onClick={() =>
                    setRetailPackages((prev) => [
                      ...prev,
                      {
                        id: `retail-${Date.now().toString(36)}`,
                        name: "Starter Pack",
                        gameAmountBillions: "500",
                        priceNaira: "600",
                        promoPriceNaira: "",
                        promoLabel: "",
                        enabled: true,
                      },
                    ])
                  }
                  className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                >
                  + Add Package
                </button>
              </div>

              <div className="space-y-3 max-h-[340px] overflow-y-auto pr-1">
                {retailPackages.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    No retail packages yet. Click &ldquo;+ Add Package&rdquo; to create one.
                  </p>
                ) : (
                  retailPackages.map((pkg, idx) => (
                    <div key={pkg.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <input
                          type="text"
                          placeholder="Package name"
                          className="flex-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold"
                          value={pkg.name}
                          onChange={(e) =>
                            setRetailPackages((prev) =>
                              prev.map((r, i) => (i === idx ? { ...r, name: e.target.value } : r))
                            )
                          }
                        />
                        <label className="flex items-center gap-1 text-[11px] text-slate-700">
                          <input
                            type="checkbox"
                            checked={pkg.enabled}
                            onChange={(e) =>
                              setRetailPackages((prev) =>
                                prev.map((r, i) => (i === idx ? { ...r, enabled: e.target.checked } : r))
                              )
                            }
                          />
                          Enabled
                        </label>
                        <button
                          type="button"
                          onClick={() => setRetailPackages((prev) => prev.filter((_, i) => i !== idx))}
                          className="text-xs font-bold text-rose-600 hover:text-rose-800"
                        >
                          Remove
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[10px] text-slate-500">Amount (Billions)</label>
                          <input
                            type="number"
                            min="1"
                            className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs font-mono-tabular"
                            value={pkg.gameAmountBillions}
                            onChange={(e) =>
                              setRetailPackages((prev) =>
                                prev.map((r, i) =>
                                  i === idx ? { ...r, gameAmountBillions: e.target.value } : r
                                )
                              )
                            }
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-500">Price (₦)</label>
                          <input
                            type="number"
                            min="1"
                            step="0.01"
                            className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs font-mono-tabular"
                            value={pkg.priceNaira}
                            onChange={(e) =>
                              setRetailPackages((prev) =>
                                prev.map((r, i) => (i === idx ? { ...r, priceNaira: e.target.value } : r))
                              )
                            }
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-500">Promo Price (₦, opt)</label>
                          <input
                            type="number"
                            min="1"
                            step="0.01"
                            placeholder="None"
                            className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs font-mono-tabular"
                            value={pkg.promoPriceNaira}
                            onChange={(e) =>
                              setRetailPackages((prev) =>
                                prev.map((r, i) =>
                                  i === idx ? { ...r, promoPriceNaira: e.target.value } : r
                                )
                              )
                            }
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-500">Promo Label (opt)</label>
                          <input
                            type="text"
                            placeholder="e.g. Flash Deal"
                            className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                            value={pkg.promoLabel}
                            onChange={(e) =>
                              setRetailPackages((prev) =>
                                prev.map((r, i) => (i === idx ? { ...r, promoLabel: e.target.value } : r))
                              )
                            }
                          />
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Audit Reason (min 3 chars)
                </label>
                <input
                  type="text"
                  required
                  minLength={3}
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm"
                  placeholder="e.g. Update retail package catalog"
                  value={retailReason}
                  onChange={(e) => setRetailReason(e.target.value)}
                />
              </div>
              <Button type="submit" variant="owner" disabled={savingRetail}>
                {savingRetail ? "Saving…" : "Save Retail Pricing"}
              </Button>
            </form>
          </Card>
        </div>

        <Card title="Customer Pricing Preview">
          <div className="grid gap-4 md:grid-cols-2 items-center">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Test Bulk Order Quantity (T)
              </label>
              <input
                type="number"
                min="1"
                step="1"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular text-sm"
                value={previewTrillions}
                onChange={(e) => setPreviewTrillions(e.target.value)}
              />
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Live Customer Quote
              </p>
              <p
                className={`mt-1 font-mono-tabular font-semibold ${
                  previewResult.tone === "ok" ? "text-emerald-700" : "text-rose-700"
                }`}
              >
                {previewResult.text}
              </p>
            </div>
          </div>
          {retailStatus === "CONFIGURED" && retailPackages.some((p) => p.enabled) && (
            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              {retailPackages
                .filter((p) => p.enabled)
                .map((p) => (
                  <div key={p.id} className="rounded-lg border border-slate-200 p-2.5 text-xs">
                    <div className="font-semibold text-slate-900">{p.name}</div>
                    <div className="text-slate-500">
                      {formatTrillions((BigInt(p.gameAmountBillions || "0") * ONE_BILLION).toString())}
                    </div>
                    <div className="mt-1 font-mono-tabular font-bold text-emerald-700">
                      ₦{p.promoPriceNaira || p.priceNaira}
                      {p.promoLabel ? ` · ${p.promoLabel}` : ""}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </Card>
      </div>
    </OwnerShell>
  );
}
