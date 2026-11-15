"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/Button";
import { AuthLayout } from "@/components/ui/AuthLayout";

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { refresh } = useAuth();

  const initialRef = searchParams.get("ref") ?? "";
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [lagoslifeUsername, setLagoslifeUsername] = useState("");
  const [referralCode, setReferralCode] = useState(initialRef);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await apiRequest("/auth/register", {
        method: "POST",
        body: JSON.stringify({
          fullName: fullName.trim(),
          email: email.trim(),
          phone: phone.trim() || undefined,
          lagoslifeUsername: lagoslifeUsername.trim() || undefined,
          referralCode: referralCode.trim() || undefined,
          password,
        }),
      });
      // Sign in immediately after registration
      await apiRequest("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), password }),
      });
      await refresh();
      router.replace("/marketplace");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout
      title="Create Account"
      subtitle="Join Big Ola Marketplace to reserve and buy LagosLife currency"
      footer={
        <p>
          Already have an account?{" "}
          <Link href="/login" className="font-semibold text-emerald-400 hover:underline">
            Sign in
          </Link>
        </p>
      }
    >
      <div>
        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Full name</label>
            <input
              type="text"
              required
              minLength={2}
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#059669] focus:outline-none"
              placeholder="Adebayo Ogunleye"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Email address</label>
            <input
              type="email"
              required
              autoComplete="email"
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#059669] focus:outline-none"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Phone (optional)</label>
              <input
                type="tel"
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#059669] focus:outline-none"
                placeholder="0803..."
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                LagosLife Username (optional)
              </label>
              <input
                type="text"
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#059669] focus:outline-none"
                placeholder="your_handle"
                value={lagoslifeUsername}
                onChange={(e) => setLagoslifeUsername(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Partner Referral Code (optional)
            </label>
            <input
              type="text"
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 font-mono-tabular text-sm text-slate-900 focus:border-[#059669] focus:outline-none"
              placeholder="e.g. BGO-123ABC"
              value={referralCode}
              onChange={(e) => setReferralCode(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Password (min 10 characters)
            </label>
            <input
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#059669] focus:outline-none"
              placeholder="Create a strong password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <Button type="submit" disabled={loading} className="w-full" size="lg">
            {loading ? "Creating account…" : "Create Customer Account"}
          </Button>
        </form>
      </div>
    </AuthLayout>
  );
}

export default function RegisterPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#0B1324] flex items-center justify-center text-sm text-slate-300">
          Loading registration…
        </div>
      }
    >
      <RegisterForm />
    </Suspense>
  );
}
