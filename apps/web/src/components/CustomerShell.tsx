"use client";

import type { ReactNode } from "react";
import { RequireRole } from "@/lib/auth-context";
import { AppShell, type NavItem } from "@/components/ui/AppShell";

const CUSTOMER_NAV: NavItem[] = [
  { label: "Buy Currency", href: "/marketplace" },
  { label: "My Orders", href: "/marketplace/orders" },
  { label: "Support", href: "/marketplace/support" },
  { label: "Account & Profile", href: "/marketplace/account" },
];

export function CustomerShell({ children }: { children: ReactNode }) {
  return (
    <RequireRole allowedRoles={["CUSTOMER"]}>
      <AppShell workspaceTitle="Customer Marketplace" accentHex="#059669" navItems={CUSTOMER_NAV}>
        {children}
      </AppShell>
    </RequireRole>
  );
}
