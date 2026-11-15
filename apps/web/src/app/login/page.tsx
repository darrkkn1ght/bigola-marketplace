"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { roleHomePath } from "@/lib/format";
import { Button, CopyButton } from "@/components/ui/Button";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, refresh } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Owner 2FA states
  const [step, setStep] = useState<"CREDENTIALS" | "MFA_VERIFY" | "MFA_SETUP" | "MFA_RECOVERY_CODES">(
    "CREDENTIALS"
  );
  const [totpCode, setTotpCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCodeInput, setRecoveryCodeInput] = useState("");
  const [setupKey, setSetupKey] = useState("");
  const [setupUri, setSetupUri] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

  useEffect(() => {
    if (!user) return;
    if (user.role === "OWNER" && (!user.mfaEnabled || !user.mfaVerified)) {
      if (!user.mfaEnabled && step === "CREDENTIALS") {
        void initiateMfaSetup();
      } else if (user.mfaEnabled && !user.mfaVerified && step === "CREDENTIALS") {
        setStep("MFA_VERIFY");
      }
      return;
    }
    const next = searchParams.get("next");
    if (next && next.startsWith("/")) {
      router.replace(next);
    } else {
      router.replace(roleHomePath(user.role));
    }
  }, [user, step, router, searchParams]);

  async function initiateMfaSetup() {
    setError(null);
    try {
      const res = await apiRequest<{ manualKey: string; otpauthUri: string }>("/auth/2fa/setup", {
        method: "POST",
      });
      setSetupKey(res.manualKey);
      setSetupUri(res.otpauthUri);
      setStep("MFA_SETUP");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await apiRequest("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const me = await refresh();
      if (!me) {
        setError("Session could not be verified. Please try again.");
        return;
      }
      if (me.role === "OWNER" && (!me.mfaEnabled || !me.mfaVerified)) {
        if (!me.mfaEnabled) {
          await initiateMfaSetup();
        } else {
          setStep("MFA_VERIFY");
        }
        return;
      }
      const next = searchParams.get("next");
      router.replace(next && next.startsWith("/") ? next : roleHomePath(me.role));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleEnableMfa(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiRequest<{ recoveryCodes: string[] }>("/auth/2fa/enable", {
        method: "POST",
        body: JSON.stringify({ code: totpCode.trim() }),
      });
      setRecoveryCodes(res.recoveryCodes);
      await refresh();
      setStep("MFA_RECOVERY_CODES");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyMfa(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (useRecovery) {
        await apiRequest("/auth/2fa/recover", {
          method: "POST",
          body: JSON.stringify({ recoveryCode: recoveryCodeInput.trim() }),
        });
      } else {
        await apiRequest("/auth/2fa/verify", {
          method: "POST",
          body: JSON.stringify({ code: totpCode.trim() }),
        });
      }
      await refresh();
      router.replace("/owner");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col justify-center px-4 py-12">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-8 text-center">
          <Link href="/" className="inline-flex items-center gap-2.5">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-[#059669] text-sm font-bold text-white">
              BO
            </span>
            <span className="text-lg font-semibold text-slate-900">Big Ola Marketplace</span>
          </Link>
          <p className="mt-2 text-sm text-slate-500">
            {step === "CREDENTIALS" && "Sign in to your Customer, Partner, or Owner account"}
            {step === "MFA_VERIFY" && "Owner Two-Factor Verification"}
            {step === "MFA_SETUP" && "Set Up Mandatory Owner 2FA"}
            {step === "MFA_RECOVERY_CODES" && "Save Your One-Time Recovery Codes"}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 shadow-xs">
          {error && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700">
              {error}
            </div>
          )}

          {step === "CREDENTIALS" && (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Email address</label>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#059669] focus:outline-none"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-slate-700">Password</label>
                  <Link href="/forgot-password" className="text-xs font-medium text-[#059669] hover:underline">
                    Forgot password?
                  </Link>
                </div>
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#059669] focus:outline-none"
                  placeholder="••••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={loading} className="w-full" size="lg">
                {loading ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          )}

          {step === "MFA_SETUP" && (
            <form onSubmit={handleEnableMfa} className="space-y-4">
              <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3.5 text-xs text-indigo-900 space-y-2">
                <p className="font-semibold">Authenticator App Required</p>
                <p>
                  Add this key to Google Authenticator, Authy, or 1Password, then enter the 6-digit code below.
                </p>
                <div className="flex items-center justify-between gap-2 rounded-md bg-white border border-indigo-200 px-3 py-2">
                  <code className="font-mono-tabular text-xs break-all text-slate-900">{setupKey}</code>
                  <CopyButton value={setupKey} />
                </div>
                <p className="text-[11px] text-indigo-700 break-all">URI: {setupUri}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">6-digit authenticator code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-center font-mono-tabular text-lg tracking-widest text-slate-900 focus:border-[#4F46E5] focus:outline-none"
                  placeholder="000000"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                />
              </div>
              <Button type="submit" variant="owner" disabled={loading} className="w-full" size="lg">
                {loading ? "Activating 2FA…" : "Enable 2FA & Continue"}
              </Button>
            </form>
          )}

          {step === "MFA_RECOVERY_CODES" && (
            <div className="space-y-4">
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3.5 text-xs text-amber-900">
                Store these one-time recovery codes in a safe place. Each code can only be used once if you lose your authenticator app.
              </div>
              <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                {recoveryCodes.map((code) => (
                  <code key={code} className="font-mono-tabular text-xs text-slate-900 text-center py-1">
                    {code}
                  </code>
                ))}
              </div>
              <div className="flex items-center justify-between">
                <CopyButton value={recoveryCodes.join("\n")} label="Copy all codes" />
                <Button variant="owner" onClick={() => router.replace("/owner")}>
                  Continue to Owner Console
                </Button>
              </div>
            </div>
          )}

          {step === "MFA_VERIFY" && (
            <form onSubmit={handleVerifyMfa} className="space-y-4">
              {!useRecovery ? (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    6-digit authenticator code
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="\d{6}"
                    maxLength={6}
                    required
                    className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-center font-mono-tabular text-lg tracking-widest text-slate-900 focus:border-[#4F46E5] focus:outline-none"
                    placeholder="000000"
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value)}
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    One-time recovery code
                  </label>
                  <input
                    type="text"
                    required
                    className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 font-mono-tabular text-sm text-slate-900 focus:border-[#4F46E5] focus:outline-none"
                    placeholder="XXXX-XXXX"
                    value={recoveryCodeInput}
                    onChange={(e) => setRecoveryCodeInput(e.target.value)}
                  />
                </div>
              )}

              <Button type="submit" variant="owner" disabled={loading} className="w-full" size="lg">
                {loading ? "Verifying…" : "Verify & Open Owner Console"}
              </Button>

              <button
                type="button"
                onClick={() => setUseRecovery((v) => !v)}
                className="w-full text-center text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
              >
                {useRecovery ? "Use 6-digit authenticator code instead" : "Lost your device? Use a recovery code"}
              </button>
            </form>
          )}
        </div>

        <div className="mt-6 text-center text-xs text-slate-500 space-y-2">
          <p>
            New customer?{" "}
            <Link href="/register" className="font-medium text-[#059669] hover:underline">
              Create an account
            </Link>
          </p>
          <p>
            Have a Partner invite or reset token?{" "}
            <Link href="/reset-password" className="font-medium text-slate-700 hover:underline">
              Set your password
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center text-sm text-slate-500">
          Loading sign-in…
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
