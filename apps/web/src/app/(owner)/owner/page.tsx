import { PRIMARY_SUPPLIER_USERNAME } from "@bigola/shared";
import { RoleShell } from "@/components/RoleShell";

export default function OwnerConsolePage() {
  return (
    <RoleShell surface="Owner Console" accentClass="bg-amber-400">
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
        <h1 className="text-2xl font-semibold text-white">
          Owner Console — {PRIMARY_SUPPLIER_USERNAME}
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          2FA-enforced operational surface for 1 Main Treasury ({PRIMARY_SUPPLIER_USERNAME}) + 4 Reserve Accounts
          (70T target each = 280T initial active reserve), configurable commercial settings, and append-only audit logs.
        </p>
      </div>
    </RoleShell>
  );
}

