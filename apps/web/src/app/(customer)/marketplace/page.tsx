import { RoleShell } from "@/components/RoleShell";

export default function CustomerMarketplacePage() {
  return (
    <RoleShell surface="Customer Marketplace" accentClass="bg-emerald-400">
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
        <h1 className="text-2xl font-semibold text-white">Customer Marketplace</h1>
        <p className="mt-2 text-sm text-slate-400">
          Isolated customer surface. Bulk pricing defaults to ₦1,000 per 1T (10T minimum, Owner-configurable);
          regular retail packages and bank details remain configurable settings pending Phase 4 activation.
        </p>
      </div>
    </RoleShell>
  );
}

