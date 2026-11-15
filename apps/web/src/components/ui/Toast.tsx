"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type ToastTone = "success" | "error" | "info" | "warning";

interface ToastItem {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
}

interface ToastContextValue {
  pushToast: (toast: Omit<ToastItem, "id">) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_STYLES: Record<ToastTone, string> = {
  success: "border-emerald-200 bg-white text-slate-900 ring-1 ring-emerald-500/15",
  error: "border-red-200 bg-white text-slate-900 ring-1 ring-red-500/15",
  warning: "border-amber-200 bg-white text-slate-900 ring-1 ring-amber-500/15",
  info: "border-slate-200 bg-white text-slate-900 ring-1 ring-slate-900/5",
};

const DOT_STYLES: Record<ToastTone, string> = {
  success: "bg-emerald-500",
  error: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-sky-500",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const pushToast = useCallback((toast: Omit<ToastItem, "id">) => {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev.slice(-3), { ...toast, id }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 3600);
  }, []);

  return (
    <ToastContext.Provider value={{ pushToast }}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2 px-4 sm:px-0"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 shadow-lg transition-all duration-200 ${TONE_STYLES[toast.tone]}`}
          >
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT_STYLES[toast.tone]}`} />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-[#0B1324]">{toast.title}</p>
              {toast.description && (
                <p className="mt-0.5 text-xs text-slate-600">{toast.description}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => setToasts((prev) => prev.filter((item) => item.id !== toast.id))}
              className="text-xs text-slate-400 hover:text-slate-700 cursor-pointer"
              aria-label="Dismiss notification"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return {
      pushToast: () => undefined,
    };
  }
  return ctx;
}
