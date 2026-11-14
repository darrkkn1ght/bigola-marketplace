import { RoleShell } from "@/components/RoleShell";

export default function PartnerPortalPage() {
  return (
    <RoleShell surface="Partner Portal" accentClass="bg-sky-400">
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
        <h1 className="text-2xl font-semibold text-white">Sales Partner Portal</h1>
        <p className="mt-2 text-sm text-slate-400">
          Isolated partner surface. Category A attributed customers generate an immutable 50/50 split of gross
          verified payments. Category B remains <span className="text-amber-300">PENDING_RULE</span> until configured.
        </p>
      </div>
    </RoleShell>
  );
}

