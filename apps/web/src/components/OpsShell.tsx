"use client";

import type { ReactNode } from "react";
import { RequireRole } from "@/lib/auth-context";
import { AppShell, type NavItem } from "@/components/ui/AppShell";

const OPS_NAV: NavItem[] = [
  { label: "Orders & Fulfilment", href: "/ops" },
  { label: "Support Desk", href: "/ops/support" },
];

export function OpsShell({ children }: { children: ReactNode }) {
  return (
    <RequireRole allowedRoles={["OPS_ADMIN", "OWNER"]}>
      <AppShell workspaceTitle="Operations Desk" accentHex="#7C3AED" navItems={OPS_NAV}>
        {children}
      </AppShell>
    </RequireRole>
  );
}
