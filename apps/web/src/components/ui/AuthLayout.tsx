"use client";

import type { ReactNode } from "react";
import Link from "next/link";

export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#0B1324] text-white flex flex-col justify-center px-4 py-10 sm:py-14">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-7 text-center">
          <Link href="/" className="inline-flex items-center gap-3 group">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[#059669] text-sm font-extrabold tracking-tight text-white shadow-md ring-1 ring-white/20 transition-transform group-hover:scale-[1.03]">
              BO
            </span>
            <div className="text-left leading-tight">
              <span className="font-display block text-lg font-extrabold tracking-tight text-white">
                Big Ola Marketplace
              </span>
              <span className="block text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                Verified LagosLife Currency
              </span>
            </div>
          </Link>
          <h1 className="font-display mt-5 text-2xl font-bold text-white">{title}</h1>
          <p className="mt-1 text-sm text-slate-300">{subtitle}</p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white p-6 sm:p-8 text-[#0B1324] shadow-2xl">
          {children}
        </div>

        {footer && (
          <div className="mt-6 text-center text-xs text-slate-300 space-y-2">{footer}</div>
        )}
      </div>
    </div>
  );
}
