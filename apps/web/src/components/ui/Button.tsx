"use client";

import { useState } from "react";
import { useToast } from "./Toast";

type ButtonVariant = "primary" | "navy" | "partner" | "owner" | "secondary" | "danger" | "ghost";
type ButtonSize = "sm" | "md" | "lg";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-[#059669] text-white hover:bg-[#047857] focus-visible:ring-emerald-500/40 shadow-xs",
  navy: "bg-[#0B1324] text-white hover:bg-[#162340] focus-visible:ring-slate-700/40 shadow-xs",
  partner: "bg-[#0284C7] text-white hover:bg-sky-700 focus-visible:ring-sky-500/40 shadow-xs",
  owner:
    "bg-[#0B1324] text-white hover:bg-[#162340] ring-1 ring-emerald-500/20 focus-visible:ring-emerald-500/40 shadow-xs",
  secondary:
    "border border-slate-300 bg-white text-[#0B1324] hover:bg-slate-50 hover:border-slate-400 focus-visible:ring-slate-400/40 shadow-xs",
  danger: "bg-[#DC2626] text-white hover:bg-red-700 focus-visible:ring-red-500/40 shadow-xs",
  ghost: "text-slate-600 hover:bg-slate-100 hover:text-[#0B1324] focus-visible:ring-slate-400/30",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-5 py-2.5 text-sm",
};

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-all duration-150 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
    >
      {children}
    </button>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const { pushToast } = useToast();

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      pushToast({ title: "Copied to clipboard", description: value, tone: "success" });
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold transition-all duration-150 cursor-pointer ${
        copied
          ? "border-emerald-300 bg-emerald-50 text-emerald-700"
          : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 hover:border-slate-300"
      }`}
    >
      {copied ? "✓ Copied" : label}
    </button>
  );
}
