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
    <div className="min-h-screen bg-[#F4F6FA] text-[#0B1324]">
      {/* Top Navbar */}
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[#0B1324]/95 backdrop-blur-md text-white">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[#059669] text-xs font-extrabold tracking-tight text-white shadow-sm ring-1 ring-white/15">
              BO
            </span>
            <div className="leading-tight">
              <span className="font-display block text-sm font-bold tracking-tight text-white">
                Big Ola Marketplace
              </span>
              <span className="hidden sm:block text-[10px] font-medium uppercase tracking-wider text-emerald-400">
                Verified LagosLife Currency
              </span>
            </div>
          </Link>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-300">
            <a href="#how-it-works" className="hover:text-white transition-colors">
              How it works
            </a>
            <a href="#pricing" className="hover:text-white transition-colors">
              Pricing
            </a>
            <Link href="/marketplace" className="hover:text-white transition-colors">
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
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-slate-200 hover:bg-white/10 hover:text-white"
                  >
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

      {/* Deep Navy Fintech Hero */}
      <section className="bg-[#0B1324] text-white border-b border-[#162340]">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
          <div className="grid gap-10 lg:grid-cols-12 lg:items-center">
            <div className="lg:col-span-7 space-y-6">
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-1 text-xs font-semibold text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                Verified LagosLife Desk • Treasury: {PRIMARY_SUPPLIER_USERNAME}
              </div>

              <h1 className="font-display text-3xl font-extrabold tracking-tight text-white sm:text-5xl leading-[1.12]">
                Buy LagosLife Currency with Verified OPay Transfers.
              </h1>

              <p className="max-w-xl text-base text-slate-300 leading-relaxed">
                Lock in your exact bulk quantity in seconds, transfer to the verified OPay receiving account, and track payment confirmation and delivery progress in real time.
              </p>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Link href={user ? "/marketplace" : "/register"}>
                  <Button size="lg">Buy Currency Now</Button>
                </Link>
                <Link href="/login">
                  <Button
                    variant="secondary"
                    size="lg"
                    className="border-white/20 bg-white/5 text-white hover:bg-white/10 hover:border-white/30"
                  >
                    Sign in to Your Account
                  </Button>
                </Link>
              </div>
            </div>

            <div className="lg:col-span-5">
              <div className="rounded-2xl border border-white/10 bg-[#111C33] p-6 shadow-2xl space-y-5">
                <div className="flex items-start justify-between gap-3 border-b border-white/10 pb-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      Current Bulk Rate
                    </p>
                    <p className="font-display mt-1.5 text-3xl font-extrabold text-white tabular-nums">
                      {bulk ? formatNaira(bulk.priceKoboPerTrillion) : "₦1,000.00"}{" "}
                      <span className="text-sm font-medium text-slate-400">/ 1T</span>
                    </p>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${
                      isFresh
                        ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300"
                        : "border-amber-500/30 bg-amber-500/15 text-amber-300"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        isFresh ? "bg-emerald-400" : "bg-amber-400"
                      }`}
                    />
                    {isFresh ? "Live Stock Ready" : "Checking Stock"}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3.5 text-sm">
                  <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3.5">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                      Minimum Order
                    </p>
                    <p className="font-display mt-1 text-lg font-bold text-white tabular-nums">
                      {bulk ? formatTrillions(bulk.minBulkGameAmount) : "10T"}
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3.5">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                      Reservable Stock
                    </p>
                    <p className="font-display mt-1 text-lg font-bold text-emerald-400 tabular-nums">
                      {reservableAvailable ? formatTrillions(reservableAvailable) : "—"}
                    </p>
                  </div>
                </div>

                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.07] p-3.5 text-xs text-slate-300 space-y-1">
                  <p className="font-semibold text-emerald-300">Payment Security Guarantee</p>
                  <p className="leading-relaxed">
                    All payments are verified against confirmed OPay bank credits. We never ask for your OPay PIN, password, or OTP.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="border-b border-slate-200/80 bg-white py-14 sm:py-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="max-w-2xl">
            <p className="text-xs font-bold uppercase tracking-wider text-[#059669]">
              Settlement Flow
            </p>
            <h2 className="font-display mt-1 text-2xl font-bold text-[#0B1324]">
              How purchasing works
            </h2>
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
              <div
                key={item.step}
                className="rounded-xl border border-slate-200/90 bg-[#F8FAFC] p-5 transition-all duration-200 hover:border-emerald-300 hover:bg-white hover:shadow-sm"
              >
                <span className="inline-flex rounded-md bg-[#0B1324] px-2 py-0.5 font-mono-tabular text-[11px] font-bold text-emerald-400">
                  STEP {item.step}
                </span>
                <h3 className="font-display mt-3 text-sm font-bold text-[#0B1324]">
                  {item.title}
                </h3>
                <p className="mt-1.5 text-xs text-slate-600 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing Summary */}
      <section id="pricing" className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="rounded-2xl border border-slate-200/90 bg-white p-6 sm:p-8 shadow-xs flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-[#059669]">
              Bulk Exchange Desk
            </p>
            <h2 className="font-display mt-1 text-xl font-bold text-[#0B1324]">
              Transparent Bulk Pricing
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              {bulk ? formatNaira(bulk.priceKoboPerTrillion) : "₦1,000.00"} per 1T • Minimum order{" "}
              {bulk ? formatTrillions(bulk.minBulkGameAmount) : "10T"} • 1T increments. Retail packages are pending Owner configuration.
            </p>
          </div>
          <Link href="/marketplace" className="shrink-0">
            <Button size="lg">Open Calculator</Button>
          </Link>
        </div>
      </section>
    </div>
  );
}
