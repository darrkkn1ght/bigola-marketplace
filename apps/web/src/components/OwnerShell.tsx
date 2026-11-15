"use client";

import type { ReactNode } from "react";
import { RequireRole } from "@/lib/auth-context";
import { AppShell, type NavItem } from "@/components/ui/AppShell";

const OWNER_NAV: NavItem[] = [
  { label: "Overview", href: "/owner" },
  { label: "Analytics", href: "/owner/analytics" },
  { label: "Orders", href: "/owner/orders" },
  { label: "Verification", href: "/owner/verification" },
  { label: "Inventory", href: "/owner/inventory" },
  { label: "Pricing", href: "/owner/pricing" },
  { label: "Partners & OPay", href: "/owner/partners" },
  { label: "Customers", href: "/owner/customers" },
  { label: "Support", href: "/owner/support" },
  { label: "Audit Logs", href: "/owner/audit-logs" },
  { label: "Settings & Security", href: "/owner/settings" },
];

export function OwnerShell({ children }: { children: ReactNode }) {
  return (
    <RequireRole allowedRoles={["OWNER"]}>
      <AppShell workspaceTitle="Owner Control Centre" accentHex="#4F46E5" navItems={OWNER_NAV}>
        {children}
      </AppShell>
    </RequireRole>
  );
}
