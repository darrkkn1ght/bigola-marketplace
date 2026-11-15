export function SkeletonLine({ className = "h-4 w-full" }: { className?: string }) {
  return <div className={`skeleton-shimmer rounded-md ${className}`} />;
}

export function SkeletonCard({ rows = 3 }: { rows?: number }) {
  return (
    <div className="rounded-xl border border-slate-200/80 bg-white p-5 sm:p-6 shadow-[0_1px_2px_rgba(11,19,36,0.04)] space-y-3">
      <SkeletonLine className="h-4 w-40" />
      <SkeletonLine className="h-3 w-64" />
      <div className="pt-2 space-y-2.5">
        {Array.from({ length: rows }).map((_, idx) => (
          <SkeletonLine key={idx} className="h-10 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}
