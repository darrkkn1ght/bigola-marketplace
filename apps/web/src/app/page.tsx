"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PRIMARY_SUPPLIER_USERNAME } from "@bigola/shared";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { formatNaira, formatTrillions, roleHomePath } from "@/lib/format";
import { Button } from "@/components/ui/Button";

interface BulkPricingInfo {
  priceKoboPerTrillion: string;
  minBulkGameAmount: string;
  enabled: boolean;
}

interface PublicCatalog {
  bulk?: BulkPricingInfo;
  bulkPricing?: BulkPricingInfo;
  availability?: {
    reservableAvailable?: string;
    totalReservableAvailable?: string;
    isFresh?: boolean;
    activeFreshSlotCount?: number;
  };
}

export default function HomePage() {
  const { user } = useAuth();
  const [catalog, setCatalog] = useState<PublicCatalog | null>(null);

  useEffect(() => {
    apiRequest<PublicCatalog>("/catalog/pricing")
      .then(setCatalog)
      .catch(() => setCatalog(null));
  }, []);

  const bulk = catalog?.bulk ?? catalog?.bulkPricing;
  const reservableAvailable =
    catalog?.availability?.reservableAvailable ??
    catalog?.availability?.totalReservableAvailable;
  const isFresh =
    catalog?.availability?.isFresh ??
    (catalog?.availability?.activeFreshSlotCount ?? 0) > 0;

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A]">
      {/* Top Navbar */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[#059669] text-xs font-bold text-white">
              BO
            </span>
            <span className="text-base font-semibold tracking-tight text-slate-900">
              Big Ola Marketplace
            </span>
          </Link>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            <a href="#how-it-works" className="hover:text-slate-900">
              How it works
            </a>
            <a href="#pricing" className="hover:text-slate-900">
              Pricing
            </a>
            <Link href="/marketplace" className="hover:text-slate-900">
              Buy Currency
            </Link>
          </nav>

          <div className="flex items-center gap-2.5">
            {user ? (
              <Link href={roleHomePath(user.role)}>
                <Button size="sm">Open Dashboard</Button>
              </Link>
            ) : (
              <>
                <Link href="/login">
                  <Button variant="secondary" size="sm">
                    Sign in
                  </Button>
                </Link>
                <Link href="/register">
                  <Button size="sm">Get Started</Button>
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
        <div className="grid gap-10 lg:grid-cols-12 lg:items-center">
          <div className="lg:col-span-7 space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800">
              <span className="h-1.5 w-1.5 rounded-full bg-[#059669]" />
              Verified LagosLife Supply • Primary Treasury: {PRIMARY_SUPPLIER_USERNAME}
            </div>

            <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-5xl leading-tight">
              Buy LagosLife Currency with Verified OPay Transfers.
            </h1>

            <p className="max-w-xl text-base text-slate-600 leading-relaxed">
              Reserve your exact currency amount in seconds, transfer to the designated OPay receiving account, and track independent payment verification in real time.
            </p>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Link href={user ? "/marketplace" : "/register"}>
                <Button size="lg">Buy Currency Now</Button>
              </Link>
              <Link href="/login">
                <Button variant="secondary" size="lg">
                  Sign in to Your Account
                </Button>
              </Link>
            </div>
          </div>

          <div className="lg:col-span-5">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-5">
              <div className="flex items-center justify-between border-b border-slate-100 pb-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
                    Current Bulk Rate
                  </p>
                  <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
                    {bulk ? formatNaira(bulk.priceKoboPerTrillion) : "₦1,000.00"}{" "}
                    <span className="text-sm font-normal text-slate-500">/ 1T</span>
                  </p>
                </div>
                <span className="rounded-full bg-emerald-50 border border-emerald-200 px-3 py-1 text-xs font-medium text-emerald-700">
                  {isFresh ? "Live Stock Ready" : "Checking Stock"}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="rounded-lg bg-slate-50 p-3.5">
                  <p className="text-xs text-slate-500">Minimum Bulk Order</p>
                  <p className="mt-1 font-semibold text-slate-900 tabular-nums">
                    {bulk ? formatTrillions(bulk.minBulkGameAmount) : "10T"}
                  </p>
                </div>
                <div className="rounded-lg bg-slate-50 p-3.5">
                  <p className="text-xs text-slate-500">Reservable Stock</p>
                  <p className="mt-1 font-semibold text-slate-900 tabular-nums">
                    {reservableAvailable ? formatTrillions(reservableAvailable) : "—"}
                  </p>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3.5 text-xs text-slate-600 space-y-1">
                <p className="font-semibold text-slate-800">Payment Security Guarantee</p>
                <p>
                  All payments are verified against confirmed OPay bank credits. We never ask for your OPay PIN, password, or OTP.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="border-t border-slate-200 bg-white py-14">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="max-w-2xl">
            <h2 className="text-2xl font-bold text-slate-900">How purchasing works</h2>
            <p className="mt-2 text-sm text-slate-600">
              Four transparent steps from stock reservation to verified fulfilment.
            </p>
          </div>

          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                step: "01",
                title: "Reserve Stock",
                desc: "Choose your bulk quantity (minimum 10T, 1T increments) and enter your LagosLife username.",
              },
              {
                step: "02",
                title: "Transfer to OPay",
                desc: "Copy the exact Naira amount, OPay account number, and order reference shown on your order.",
              },
              {
                step: "03",
                title: "Submit Proof",
                desc: "Enter your OPay transaction reference and sender name. Split transfers are supported.",
              },
              {
                step: "04",
                title: "Verified & Delivered",
                desc: "Once your bank credit is independently confirmed, your order moves to Ready for Fulfilment.",
              },
            ].map((item) => (
              <div key={item.step} className="rounded-xl border border-slate-200 bg-[#F8FAFC] p-5">
                <span className="font-mono-tabular text-xs font-bold text-[#059669]">{item.step}</span>
                <h3 className="mt-2 text-sm font-semibold text-slate-900">{item.title}</h3>
                <p className="mt-1.5 text-xs text-slate-600 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing Summary */}
      <section id="pricing" className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6">
          <div>
            <h2 className="text-xl font-bold text-slate-900">Transparent Bulk Pricing</h2>
            <p className="mt-1 text-sm text-slate-600">
              ₦1,000.00 per 1T • Minimum order 10T (₦10,000.00) • 1T increments. Retail packages are pending Owner configuration.
            </p>
          </div>
          <Link href="/marketplace">
            <Button size="lg">Open Calculator</Button>
          </Link>
        </div>
      </section>
    </div>
  );
}
