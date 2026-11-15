import { humanizeOrderStatus, type BadgeTone } from "@/lib/format";

const TONE_CLASSES: Record<BadgeTone, string> = {
  success: "bg-emerald-50 text-emerald-800 border-emerald-200/90",
  warning: "bg-amber-50 text-amber-800 border-amber-200/90",
  danger: "bg-red-50 text-red-800 border-red-200/90",
  info: "bg-sky-50 text-sky-800 border-sky-200/90",
  neutral: "bg-slate-100 text-slate-700 border-slate-200/90",
};

const DOT_CLASSES: Record<BadgeTone, string> = {
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
  info: "bg-sky-500",
  neutral: "bg-slate-400",
};

export function StatusBadge({ label, tone = "neutral" }: { label: string; tone?: BadgeTone }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tracking-tight ${TONE_CLASSES[tone]}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASSES[tone]}`} />
      {label}
    </span>
  );
}

export function OrderStatusBadge({ status }: { status: string }) {
  const meta = humanizeOrderStatus(status);
  return <StatusBadge label={meta.label} tone={meta.tone} />;
}
