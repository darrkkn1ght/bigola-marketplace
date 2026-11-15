"use client";

import { RequireRole, useAuth } from "@/lib/auth-context";
import { AppShell } from "@/components/ui/AppShell";
import { VerificationDeskPanel } from "@/components/VerificationDeskPanel";

export default function SharedVerificationPage() {
  const { user } = useAuth();
  const isOwner = user?.role === "OWNER";

  return (
    <RequireRole allowedRoles={["OWNER", "PARTNER"]} requirePartnerVerifier>
      <AppShell
        workspaceTitle="Verification Desk"
        accentHex={isOwner ? "#4F46E5" : "#0284C7"}
        navItems={
          isOwner
            ? [
                { label: "Owner Overview", href: "/owner" },
                { label: "Verification Desk", href: "/owner/verification" },
              ]
            : [
                { label: "Partner Overview", href: "/partner" },
                { label: "Verification Desk", href: "/partner/verification" },
              ]
        }
      >
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Payment Verification Desk</h1>
            <p className="mt-1 text-sm text-slate-600">
              Independent OPay statement reconciliation and payment verification.
            </p>
          </div>
          <VerificationDeskPanel isOwner={isOwner} />
        </div>
      </AppShell>
    </RequireRole>
  );
}
