"use client";

import { CustomerShell } from "@/components/CustomerShell";
import { SupportPanel } from "@/components/SupportPanel";

export default function CustomerSupportPage() {
  return (
    <CustomerShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Support & Order Disputes</h1>
          <p className="text-sm text-slate-500">
            Report payment issues, track disputes, and message Big Ola support.
          </p>
        </div>
        <SupportPanel mode="CUSTOMER" />
      </div>
    </CustomerShell>
  );
}
