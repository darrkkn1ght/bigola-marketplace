import type { ReactNode } from "react";

export function Card({
  title,
  subtitle,
  action,
  className = "",
  children,
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`rounded-xl border border-slate-200/90 bg-white p-5 sm:p-6 shadow-[0_1px_3px_rgba(11,19,36,0.04)] transition-shadow duration-200 hover:shadow-[0_4px_14px_rgba(11,19,36,0.05)] ${className}`}
    >
      {(title || subtitle || action) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3.5">
          <div className="min-w-0">
            {title && (
              <h2 className="font-display text-base font-bold text-[#0B1324]">{title}</h2>
            )}
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function StatCard({
  label,
  value,
  hint,
  accentColor = "text-[#0B1324]",
}: {
  label: string;
  value: string;
  hint?: string;
  accentColor?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200/90 bg-white p-5 shadow-[0_1px_3px_rgba(11,19,36,0.04)] transition-all duration-200 hover:border-slate-300/90 hover:shadow-[0_4px_12px_rgba(11,19,36,0.05)]">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p className={`font-display mt-2 text-2xl font-bold tabular-nums ${accentColor}`}>
        {value}
      </p>
      {hint && <p className="mt-1.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}
