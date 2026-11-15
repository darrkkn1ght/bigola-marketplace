"use client";

import type { ReactNode } from "react";
import { RequireRole, useAuth } from "@/lib/auth-context";
import { AppShell, type NavItem } from "@/components/ui/AppShell";

export function PartnerShell({
  requireVerifier = false,
  children,
}: {
  requireVerifier?: boolean;
  children: ReactNode;
}) {
  const { user } = useAuth();

  const navItems: NavItem[] = [
    { label: "Overview", href: "/partner" },
    { label: "Customers", href: "/partner/customers" },
    { label: "Orders", href: "/partner/orders" },
    { label: "Support", href: "/partner/support" },
    ...(user?.partnerCanVerifyPayments
      ? [{ label: "Verification Desk", href: "/partner/verification" }]
      : []),
    { label: "Settings & OPay", href: "/partner/settings" },
  ];

  return (
    <RequireRole allowedRoles={["PARTNER"]} requirePartnerVerifier={requireVerifier}>
      <AppShell workspaceTitle="Partner Workspace" accentHex="#0284C7" navItems={navItems}>
        {children}
      </AppShell>
    </RequireRole>
  );
}
