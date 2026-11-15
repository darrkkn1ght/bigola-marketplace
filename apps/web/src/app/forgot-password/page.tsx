"use client";

import { useState } from "react";
import Link from "next/link";
import { apiRequest } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { AuthLayout } from "@/components/ui/AuthLayout";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setLoading(true);
    try {
      const res = await apiRequest<{ message: string }>("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: email.trim() }),
      });
      setMessage(res.message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout
      title="Password Recovery"
      subtitle="Request an Owner-issued one-time password reset token"
      footer={
        <>
          <p>
            <Link href="/reset-password" className="font-semibold text-emerald-400 hover:underline">
              I already have a reset or invite token
            </Link>
          </p>
          <p>
            <Link href="/login" className="text-slate-300 hover:text-white hover:underline">
              Back to Sign in
            </Link>
          </p>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700">
            {error}
          </div>
        )}
        {message && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-xs text-emerald-800 space-y-2">
            <p className="font-medium">{message}</p>
            <Link href="/reset-password" className="inline-block font-semibold underline">
              Already have your token? Reset password now →
            </Link>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Account email
            </label>
            <input
              type="email"
              required
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-[#0B1324] focus:border-[#059669] focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={loading} className="w-full" size="lg">
            {loading ? "Submitting…" : "Log Password Reset Request"}
          </Button>
        </form>
      </div>
    </AuthLayout>
  );
}
