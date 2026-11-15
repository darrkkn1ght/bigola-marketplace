"use client";

import { useState } from "react";

type ButtonVariant = "primary" | "partner" | "owner" | "secondary" | "danger" | "ghost";
type ButtonSize = "sm" | "md" | "lg";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-[#059669] text-white hover:bg-[#047857] shadow-xs",
  partner: "bg-[#0284C7] text-white hover:bg-sky-700 shadow-xs",
  owner: "bg-[#4F46E5] text-white hover:bg-indigo-700 shadow-xs",
  secondary: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 shadow-xs",
  danger: "bg-[#DC2626] text-white hover:bg-red-700 shadow-xs",
  ghost: "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
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
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
    >
      {children}
    </button>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
    >
      {copied ? "Copied" : label}
    </button>
  );
}
