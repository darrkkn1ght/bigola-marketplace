"use client";

import { PartnerShell } from "@/components/PartnerShell";
import { SupportPanel } from "@/components/SupportPanel";

export default function PartnerSupportPage() {
  return (
    <PartnerShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Attributed Customer Support</h1>
          <p className="text-sm text-slate-500">
            Follow up on payment complaints and disputes for your attributed customers.
          </p>
        </div>
        <SupportPanel mode="PARTNER" />
      </div>
    </PartnerShell>
  );
}
