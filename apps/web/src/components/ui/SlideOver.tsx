"use client";

import { useEffect, type ReactNode } from "react";

export function SlideOver({
  open,
  onClose,
  title,
  subtitle,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[#0B1324]/50 backdrop-blur-[2px] transition-opacity">
      <div className="fixed inset-0" onClick={onClose} aria-hidden="true" />
      <div className="relative z-10 flex h-full w-full max-w-lg flex-col bg-white shadow-2xl border-l border-slate-200">
        <div className="flex items-start justify-between border-b border-slate-200 bg-[#0B1324] px-6 py-4 text-white">
          <div className="min-w-0 pr-3">
            <h2 className="font-display text-base font-bold text-white">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-slate-300">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
            aria-label="Close panel"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">{children}</div>
      </div>
    </div>
  );
}
