import Link from "next/link";
import { PRIMARY_SUPPLIER_USERNAME } from "@bigola/shared";

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-950 px-6 py-16 text-slate-100">
      <div className="max-w-3xl text-center">
        <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
          Phase 2 Foundation • Primary Supplier: {PRIMARY_SUPPLIER_USERNAME}
        </span>
        <h1 className="mt-6 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
          Big Ola Virtual Currency Marketplace
        </h1>
        <p className="mt-4 text-base text-slate-400">
          Standalone commerce &amp; distribution platform with strictly separated Customer, Partner, and Owner interfaces.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-3 text-left">
          <Link
            href="/marketplace"
            className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 hover:border-emerald-500/50 transition-colors"
          >
            <h2 className="font-semibold text-white">Customer Marketplace</h2>
            <p className="mt-1 text-xs text-slate-400">
              Browse verified availability, place bank-transfer orders, and track delivery.
            </p>
          </Link>
          <Link
            href="/partner"
            className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 hover:border-sky-500/50 transition-colors"
          >
            <h2 className="font-semibold text-white">Partner Portal</h2>
            <p className="mt-1 text-xs text-slate-400">
              Manage referral attribution and track Category A (50/50) gross commissions.
            </p>
          </Link>
          <Link
            href="/owner"
            className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 hover:border-amber-500/50 transition-colors"
          >
            <h2 className="font-semibold text-white">Owner Console</h2>
            <p className="mt-1 text-xs text-slate-400">
              2FA-protected treasury, 4-reserve topology, proof verification, and audit logs.
            </p>
          </Link>
        </div>
      </div>
    </div>
  );
}

