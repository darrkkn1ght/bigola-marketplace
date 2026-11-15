"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { apiRequest } from "./api";
import { roleHomePath } from "./format";

export interface AuthUser {
  userId: string;
  sessionId: string;
  email: string;
  role: "CUSTOMER" | "PARTNER" | "OPS_ADMIN" | "OWNER";
  mfaEnabled: boolean;
  mfaVerified: boolean;
  mustChangePassword?: boolean;
  canConfirmFulfilment?: boolean;
  partnerStatus?: string | null;
  partnerDisplayName?: string | null;
  partnerCanVerifyPayments?: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  refresh: () => Promise<AuthUser | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<AuthUser | null> => {
    try {
      const res = await apiRequest<{ user: AuthUser }>("/auth/me");
      setUser(res.user);
      return res.user;
    } catch {
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await apiRequest("/auth/logout", { method: "POST" });
    } catch {
      // Ignore logout network error and clear local state
    }
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}

export function RequireRole({
  allowedRoles,
  requirePartnerVerifier = false,
  children,
}: {
  allowedRoles: Array<AuthUser["role"]>;
  requirePartnerVerifier?: boolean;
  children: React.ReactNode;
}) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      const next = encodeURIComponent(pathname || "/");
      router.replace(`/login?next=${next}`);
      return;
    }
    if (user.role === "OWNER" && (!user.mfaEnabled || !user.mfaVerified)) {
      router.replace("/login?mfa=required");
    }
  }, [loading, user, pathname, router]);

  if (loading || !user || (user.role === "OWNER" && (!user.mfaEnabled || !user.mfaVerified))) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F8FAFC] px-4">
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-5 text-sm text-slate-600 shadow-xs">
          Verifying your session…
        </div>
      </div>
    );
  }

  if (!allowedRoles.includes(user.role)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F8FAFC] px-4">
        <div className="max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-xs space-y-4">
          <h1 className="text-lg font-semibold text-slate-900">Access Restricted</h1>
          <p className="text-sm text-slate-600">
            Your account ({user.role}) does not have permission to open this workspace.
          </p>
          <Link
            href={roleHomePath(user.role)}
            className="inline-flex items-center justify-center rounded-lg bg-[#059669] px-4 py-2 text-sm font-medium text-white hover:bg-[#047857]"
          >
            Go to Your Workspace
          </Link>
        </div>
      </div>
    );
  }

  if (requirePartnerVerifier && user.role === "PARTNER" && !user.partnerCanVerifyPayments) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F8FAFC] px-4">
        <div className="max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-xs space-y-4">
          <h1 className="text-lg font-semibold text-slate-900">Verifier Access Not Enabled</h1>
          <p className="text-sm text-slate-600">
            Independent payment verification is currently disabled for your Partner account. Contact the Owner if you need verification access.
          </p>
          <Link
            href="/partner"
            className="inline-flex items-center justify-center rounded-lg bg-[#0284C7] px-4 py-2 text-sm font-medium text-white hover:bg-sky-700"
          >
            Back to Partner Overview
          </Link>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
