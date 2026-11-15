"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { formatDateTime } from "@/lib/format";

export interface NavItem {
  label: string;
  href: string;
}

interface NotificationRow {
  id: string;
  title: string;
  message: string;
  readAt: string | null;
  createdAt: string;
}

export function AppShell({
  workspaceTitle,
  accentHex,
  navItems,
  children,
}: {
  workspaceTitle: string;
  accentHex: string;
  navItems: NavItem[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const loadNotifications = useCallback(async () => {
    if (!user) return;
    try {
      const res = await apiRequest<{ notifications: NotificationRow[]; unreadCount: number }>(
        "/notifications"
      );
      setNotifications(res.notifications);
      setUnreadCount(res.unreadCount);
    } catch {
      // Non-blocking notification fetch
    }
  }, [user]);

  useEffect(() => {
    void loadNotifications();
  }, [loadNotifications]);

  async function markAllRead() {
    try {
      await apiRequest("/notifications/read-all", { method: "POST" });
      await loadNotifications();
    } catch {
      // ignore
    }
  }

  async function handleLogout() {
    await logout();
    router.push("/login");
  }

  function isRouteActive(href: string): boolean {
    const cleanPath = pathname.replace(/\/$/, "") || "/";
    const cleanHref = href.replace(/\/$/, "") || "/";
    return (
      cleanPath === cleanHref ||
      (cleanHref !== "/marketplace" &&
        cleanHref !== "/partner" &&
        cleanHref !== "/owner" &&
        cleanHref !== "/ops" &&
        cleanPath.startsWith(cleanHref))
    );
  }

  const activeNav = navItems.find((item) => isRouteActive(item.href));

  return (
    <div className="min-h-screen bg-[#F4F6FA] text-[#0B1324] flex overflow-x-hidden">
      {/* Desktop Deep Navy Command Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 bg-[#0B1324] text-slate-200 border-r border-[#162340] max-h-screen">
        <div className="flex h-16 items-center gap-3 border-b border-white/10 px-5">
          <span
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-xs font-extrabold tracking-tight text-white shadow-sm ring-1 ring-white/15"
            style={{ backgroundColor: accentHex }}
          >
            BO
          </span>
          <div className="min-w-0">
            <p className="font-display truncate text-sm font-bold text-white">Big Ola</p>
            <p className="truncate text-[11px] font-medium text-slate-400">{workspaceTitle}</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4 overflow-y-auto">
          {navItems.map((item) => {
            const active = isRouteActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`group flex items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150 ${
                  active
                    ? "bg-white/10 text-white shadow-xs"
                    : "text-slate-300/85 hover:bg-white/[0.06] hover:text-white"
                }`}
              >
                <span className="flex items-center gap-2.5 truncate">
                  <span
                    className={`h-1.5 w-1.5 rounded-full transition-opacity ${
                      active ? "opacity-100" : "opacity-0 group-hover:opacity-50"
                    }`}
                    style={{ backgroundColor: accentHex }}
                  />
                  <span className="truncate">{item.label}</span>
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-white/10 p-4 space-y-3 bg-[#070D1A]/60">
          <div className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-xs">
            <p className="truncate font-semibold text-white">{user?.email ?? "—"}</p>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-[11px] font-medium text-slate-400">{user?.role ?? ""}</span>
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: accentHex }}
              />
            </div>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="w-full rounded-lg border border-white/15 bg-white/[0.05] px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Mobile Sidebar Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-[#0B1324]/60 backdrop-blur-[2px]"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative z-10 flex w-72 max-w-[85vw] flex-col bg-[#0B1324] text-slate-200 border-r border-white/10 shadow-2xl">
            <div className="flex h-16 items-center justify-between border-b border-white/10 px-5">
              <div className="flex items-center gap-2.5">
                <span
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-xs font-extrabold text-white"
                  style={{ backgroundColor: accentHex }}
                >
                  BO
                </span>
                <div>
                  <p className="font-display text-sm font-bold text-white">Big Ola</p>
                  <p className="text-[11px] text-slate-400">{workspaceTitle}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white cursor-pointer"
                aria-label="Close navigation menu"
              >
                ✕
              </button>
            </div>
            <nav className="flex-1 space-y-1 px-3 py-4 overflow-y-auto">
              {navItems.map((item) => {
                const active = isRouteActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileMenuOpen(false)}
                    className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium ${
                      active
                        ? "bg-white/10 text-white"
                        : "text-slate-300 hover:bg-white/[0.06] hover:text-white"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${active ? "opacity-100" : "opacity-0"}`}
                      style={{ backgroundColor: accentHex }}
                    />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <div className="border-t border-white/10 p-4 space-y-2.5 bg-[#070D1A]/60">
              <p className="truncate text-xs font-semibold text-white">{user?.email}</p>
              <button
                type="button"
                onClick={handleLogout}
                className="w-full rounded-lg border border-white/15 bg-white/[0.05] px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-white/10 cursor-pointer"
              >
                Sign out
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-slate-200/80 bg-white/90 backdrop-blur-md px-4 sm:px-8">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-[#0B1324] hover:bg-slate-50 cursor-pointer"
            >
              <span>☰</span>
              <span>Menu</span>
            </button>
            <div className="hidden sm:flex items-center gap-2 text-xs text-slate-500 min-w-0">
              <span className="font-semibold text-[#0B1324]">{workspaceTitle}</span>
              {activeNav && (
                <>
                  <span className="text-slate-300">/</span>
                  <span className="truncate font-medium text-slate-600">{activeNav.label}</span>
                </>
              )}
            </div>
            <span className="text-sm font-bold text-[#0B1324] sm:hidden truncate">
              {activeNav?.label ?? workspaceTitle}
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            <div className="relative">
              <button
                type="button"
                onClick={() => setNotifOpen((prev) => !prev)}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-[#0B1324] hover:bg-slate-50 hover:border-slate-300 transition-colors cursor-pointer"
              >
                <span>Notifications</span>
                {unreadCount > 0 ? (
                  <span
                    className="inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold text-white"
                    style={{ backgroundColor: accentHex }}
                  >
                    {unreadCount}
                  </span>
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
                )}
              </button>

              {notifOpen && (
                <>
                  <div
                    className="fixed inset-0 z-30"
                    onClick={() => setNotifOpen(false)}
                    aria-hidden="true"
                  />
                  <div className="absolute right-0 mt-2 w-80 sm:w-96 rounded-xl border border-slate-200 bg-white p-4 shadow-xl z-40">
                    <div className="mb-3 flex items-center justify-between border-b border-slate-100 pb-2.5">
                      <p className="font-display text-xs font-bold text-[#0B1324]">
                        Recent Updates
                      </p>
                      {unreadCount > 0 && (
                        <button
                          type="button"
                          onClick={markAllRead}
                          className="text-xs font-semibold text-emerald-700 hover:underline cursor-pointer"
                        >
                          Mark all read
                        </button>
                      )}
                    </div>
                    {notifications.length === 0 ? (
                      <div className="rounded-lg bg-slate-50 px-3 py-5 text-center text-xs text-slate-500">
                        No notifications yet.
                      </div>
                    ) : (
                      <div className="max-h-72 space-y-2 overflow-y-auto">
                        {notifications.slice(0, 8).map((n) => (
                          <div
                            key={n.id}
                            className={`rounded-lg border p-3 text-xs transition-colors ${
                              n.readAt
                                ? "border-slate-100 bg-slate-50/70"
                                : "border-emerald-200 bg-emerald-50/50"
                            }`}
                          >
                            <p className="font-semibold text-[#0B1324]">{n.title}</p>
                            <p className="mt-0.5 text-slate-600">{n.message}</p>
                            <p className="mt-1.5 text-[11px] text-slate-400">
                              {formatDateTime(n.createdAt)}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8 sm:py-8 max-w-7xl w-full mx-auto min-w-0">
          {children}
        </main>
      </div>
    </div>
  );
}
