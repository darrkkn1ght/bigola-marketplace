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

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A] flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 border-r border-slate-200 bg-white">
        <div className="flex h-16 items-center gap-3 border-b border-slate-200 px-5">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white"
            style={{ backgroundColor: accentHex }}
          >
            BO
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">Big Ola</p>
            <p className="truncate text-[11px] font-medium text-slate-500">{workspaceTitle}</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4 overflow-y-auto">
          {navItems.map((item) => {
            const active =
              pathname === item.href ||
              (item.href !== "/marketplace" &&
                item.href !== "/partner" &&
                item.href !== "/owner" &&
                pathname.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? "bg-slate-100 text-slate-900"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                }`}
              >
                {active && (
                  <span
                    className="mr-2.5 h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: accentHex }}
                  />
                )}
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-slate-200 p-4 space-y-2">
          <div className="text-xs">
            <p className="truncate font-medium text-slate-900">{user?.email ?? "—"}</p>
            <p className="text-slate-500">{user?.role ?? ""}</p>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Mobile Sidebar Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative z-10 flex w-72 flex-col bg-white border-r border-slate-200">
            <div className="flex h-16 items-center justify-between border-b border-slate-200 px-5">
              <div className="flex items-center gap-2.5">
                <span
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold text-white"
                  style={{ backgroundColor: accentHex }}
                >
                  BO
                </span>
                <span className="text-sm font-semibold text-slate-900">{workspaceTitle}</span>
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                ✕
              </button>
            </div>
            <nav className="flex-1 space-y-1 px-3 py-4">
              {navItems.map((item) => {
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileMenuOpen(false)}
                    className={`block rounded-lg px-3 py-2 text-sm font-medium ${
                      active ? "bg-slate-100 text-slate-900" : "text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <div className="border-t border-slate-200 p-4 space-y-2">
              <p className="truncate text-xs font-medium text-slate-800">{user?.email}</p>
              <button
                type="button"
                onClick={handleLogout}
                className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Sign out
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-slate-200 bg-white/95 backdrop-blur px-4 sm:px-8">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              Menu
            </button>
            <span className="text-sm font-semibold text-slate-900 lg:hidden">{workspaceTitle}</span>
          </div>

          <div className="flex items-center gap-3">
            <div className="relative">
              <button
                type="button"
                onClick={() => setNotifOpen((prev) => !prev)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                <span>Notifications</span>
                {unreadCount > 0 && (
                  <span
                    className="inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold text-white"
                    style={{ backgroundColor: accentHex }}
                  >
                    {unreadCount}
                  </span>
                )}
              </button>

              {notifOpen && (
                <div className="absolute right-0 mt-2 w-80 sm:w-96 rounded-xl border border-slate-200 bg-white p-4 shadow-lg z-40">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-xs font-semibold text-slate-900">Recent Updates</p>
                    {unreadCount > 0 && (
                      <button
                        type="button"
                        onClick={markAllRead}
                        className="text-xs font-medium text-emerald-700 hover:underline cursor-pointer"
                      >
                        Mark all read
                      </button>
                    )}
                  </div>
                  {notifications.length === 0 ? (
                    <p className="text-xs text-slate-500">No notifications yet.</p>
                  ) : (
                    <div className="max-h-72 space-y-2 overflow-y-auto">
                      {notifications.slice(0, 8).map((n) => (
                        <div
                          key={n.id}
                          className={`rounded-lg border p-2.5 text-xs ${
                            n.readAt ? "border-slate-100 bg-slate-50" : "border-emerald-200 bg-emerald-50/40"
                          }`}
                        >
                          <p className="font-medium text-slate-900">{n.title}</p>
                          <p className="mt-0.5 text-slate-600">{n.message}</p>
                          <p className="mt-1 text-[11px] text-slate-400">{formatDateTime(n.createdAt)}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-8 sm:py-8 max-w-6xl w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
