"use client";

import { useCallback, useEffect, useState } from "react";
import { ONE_TRILLION } from "@bigola/shared";
import { apiRequest } from "@/lib/api";
import { formatNaira, formatTrillions } from "@/lib/format";
import { OwnerShell } from "@/components/OwnerShell";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/Badge";

interface BulkPricingInfo {
  priceKoboPerTrillion: string;
  minBulkGameAmount: string;
  enabled: boolean;
}

interface RetailPricingInfo {
  status: "UNCONFIGURED" | "CONFIGURED";
  packages: Array<{ id: string; name: string; gameAmount: string; fiatKobo: string; enabled: boolean }>;
}

interface PricingOverview {
  bulk?: BulkPricingInfo;
  bulkPricing?: BulkPricingInfo;
  retail?: RetailPricingInfo;
  retailPricing?: RetailPricingInfo;
}

export default function OwnerPricingPage() {
  const [pricing, setPricing] = useState<PricingOverview | null>(null);
  const [priceNairaPerT, setPriceNairaPerT] = useState("1000");
  const [minTrillions, setMinTrillions] = useState("10");
  const [bulkEnabled, setBulkEnabled] = useState(true);
  const [bulkReason, setBulkReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadPricing = useCallback(async () => {
    try {
      const res = await apiRequest<PricingOverview>("/owner/pricing");
      setPricing(res);
      const bulk = res.bulk ?? res.bulkPricing;
      if (bulk) {
        setPriceNairaPerT((Number(BigInt(bulk.priceKoboPerTrillion)) / 100).toString());
        setMinTrillions((BigInt(bulk.minBulkGameAmount) / ONE_TRILLION).toString());
        setBulkEnabled(bulk.enabled);
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
      await apiRequest("/owner/pricing/bulk", {
        method: "PUT",
        body: JSON.stringify({
          priceKoboPerTrillion: BigInt(Math.round(Number(priceNairaPerT) * 100)).toString(),
          minBulkGameAmount: (BigInt(minTrillions || "10") * ONE_TRILLION).toString(),
          enabled: bulkEnabled,
          reason: bulkReason.trim(),
        }),
      });
      setNotice("Bulk pricing updated. Existing orders retain their immutable pricing snapshots.");
      setBulkReason("");
      await loadPricing();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <OwnerShell>
      <div className="space-y-6 max-w-4xl">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Pricing Management</h1>
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

        <div className="grid gap-6 md:grid-cols-2">
          <Card title="Bulk Pricing Configuration">
            <form onSubmit={handleSaveBulk} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Price per 1T (₦)
                </label>
                <input
                  type="number"
                  min="1"
                  step="0.01"
                  required
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2 font-mono-tabular text-sm"
                  value={priceNairaPerT}
                  onChange={(e) => setPriceNairaPerT(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Minimum Bulk Order (T)
                </label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  required
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2 font-mono-tabular text-sm"
                  value={minTrillions}
                  onChange={(e) => setMinTrillions(e.target.value)}
                />
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
            title="Retail Pricing"
            action={
              <StatusBadge
                label={retail?.status ?? "UNCONFIGURED"}
                tone={retail?.status === "CONFIGURED" ? "success" : "warning"}
              />
            }
          >
            {retail?.status === "CONFIGURED" && retail.packages.length > 0 ? (
              <div className="space-y-2 text-sm">
                {retail.packages.map((p) => (
                  <div key={p.id} className="flex justify-between rounded-lg border border-slate-200 p-3">
                    <span>
                      {p.name} ({formatTrillions(p.gameAmount)})
                    </span>
                    <span className="font-mono-tabular font-semibold">{formatNaira(p.fiatKobo)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-600">
                Retail pricing remains <span className="font-semibold">UNCONFIGURED</span> until explicitly configured. No placeholder retail packages are shown to buyers.
              </p>
            )}
          </Card>
        </div>
      </div>
    </OwnerShell>
  );
}
