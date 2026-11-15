"use client";

import { OwnerShell } from "@/components/OwnerShell";
import { SupportPanel } from "@/components/SupportPanel";

export default function OwnerSupportPage() {
  return (
    <OwnerShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Support & Dispute Desk</h1>
          <p className="text-sm text-slate-500">
            Manage customer complaints, order disputes, internal staff notes, and resolutions.
          </p>
        </div>
        <SupportPanel mode="OWNER" />
      </div>
    </OwnerShell>
  );
}
