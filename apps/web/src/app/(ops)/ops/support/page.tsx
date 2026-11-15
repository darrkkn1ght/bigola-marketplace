"use client";

import { OpsShell } from "@/components/OpsShell";
import { SupportPanel } from "@/components/SupportPanel";

export default function OpsSupportPage() {
  return (
    <OpsShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Operations Support Desk</h1>
          <p className="text-sm text-slate-500">
            Review support tickets, record internal notes, and resolve customer issues.
          </p>
        </div>
        <SupportPanel mode="OPS" />
      </div>
    </OpsShell>
  );
}
