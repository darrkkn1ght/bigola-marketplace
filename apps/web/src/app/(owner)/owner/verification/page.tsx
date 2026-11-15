"use client";

import { OwnerShell } from "@/components/OwnerShell";
import { VerificationDeskPanel } from "@/components/VerificationDeskPanel";

export default function OwnerVerificationPage() {
  return (
    <OwnerShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Payment Verification & Reconciliation</h1>
          <p className="mt-1 text-sm text-slate-600">
            Upload filtered OPay statements, confirm customer bank credits, issue full reversals, and inspect accountability.
          </p>
        </div>
        <VerificationDeskPanel isOwner />
      </div>
    </OwnerShell>
  );
}
