import Link from "next/link";
import { PRIMARY_SUPPLIER_USERNAME } from "@bigola/shared";

interface RoleShellProps {
  surface: "Customer Marketplace" | "Partner Portal" | "Owner Console" | "Verification Desk";
  accentClass: string;
  children: React.ReactNode;
}

export function RoleShell({ surface, accentClass, children }: RoleShellProps) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800/80 bg-slate-900/70 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <span className={`inline-flex h-2.5 w-2.5 rounded-full ${accentClass}`} />
            <div>
              <p className="text-sm font-semibold tracking-wide text-white">
                BIG OLA <span className="text-slate-400">({PRIMARY_SUPPLIER_USERNAME})</span>
              </p>
              <p className="text-xs text-slate-400">{surface}</p>
            </div>
          </div>
          <nav className="flex items-center gap-4 text-sm text-slate-300">
            <Link href="/marketplace" className="hover:text-white transition-colors">
              Marketplace
            </Link>
            <Link href="/partner" className="hover:text-white transition-colors">
              Partner
            </Link>
            <Link href="/verification" className="hover:text-white transition-colors">
              Verification
            </Link>
            <Link href="/owner" className="hover:text-white transition-colors">
              Owner
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}

