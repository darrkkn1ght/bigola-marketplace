"use client";

import { PartnerShell } from "@/components/PartnerShell";
import { VerificationDeskPanel } from "@/components/VerificationDeskPanel";

export default function PartnerVerificationPage() {
  return (
    <PartnerShell requireVerifier>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Payment Verification Desk</h1>
          <p className="mt-1 text-sm text-slate-600">
            Reconcile filtered OPay statement credits and verify customer payments independently.
          </p>
        </div>
        <VerificationDeskPanel isOwner={false} />
      </div>
    </PartnerShell>
  );
}
