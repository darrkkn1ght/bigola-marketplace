"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiRequest } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { AuthLayout } from "@/components/ui/AuthLayout";

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [token, setToken] = useState(searchParams.get("token") ?? "");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      const res = await apiRequest<{ message: string }>("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({
          token: token.trim(),
          newPassword,
        }),
      });
      setSuccess(res.message);
      setTimeout(() => router.replace("/login"), 1400);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout
      title="Set Your Password"
      subtitle="Enter your one-time invite or password reset token"
      footer={
        <p>
          <Link href="/login" className="font-semibold text-emerald-400 hover:underline">
            Back to Sign in
          </Link>
        </p>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700">
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs font-medium text-emerald-800">
            {success}
          </div>
        )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                One-time invite or reset token
              </label>
              <input
                type="text"
                required
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 font-mono-tabular text-sm text-slate-900 focus:border-[#059669] focus:outline-none"
                placeholder="Paste token from Owner"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                New password (min 10 characters)
              </label>
              <input
                type="password"
                required
                minLength={10}
                autoComplete="new-password"
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#059669] focus:outline-none"
                placeholder="Enter new password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Confirm new password</label>
              <input
                type="password"
                required
                minLength={10}
                autoComplete="new-password"
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#059669] focus:outline-none"
                placeholder="Re-enter new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>

            <Button type="submit" disabled={loading} className="w-full" size="lg">
              {loading ? "Updating password…" : "Save Password & Sign in"}
            </Button>
          </form>
      </div>
    </AuthLayout>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#0B1324] flex items-center justify-center text-sm text-slate-300">
          Loading…
        </div>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
