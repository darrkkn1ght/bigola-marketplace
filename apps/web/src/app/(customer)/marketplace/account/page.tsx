"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { CustomerShell } from "@/components/CustomerShell";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";

interface CustomerProfile {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  lagoslifeUsername: string | null;
  category: string;
  attributionSource: string;
  attributedPartner?: { displayName: string; referralCode: string } | null;
}

export default function CustomerAccountPage() {
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [lagoslifeUsername, setLagoslifeUsername] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { pushToast } = useToast();

  useEffect(() => {
    apiRequest<{ profile: CustomerProfile }>("/customer/profile")
      .then((res) => {
        setProfile(res.profile);
        setFullName(res.profile.fullName);
        setPhone(res.profile.phone ?? "");
        setLagoslifeUsername(res.profile.lagoslifeUsername ?? "");
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await apiRequest<{ profile: CustomerProfile }>("/customer/profile", {
        method: "PATCH",
        body: JSON.stringify({
          fullName: fullName.trim(),
          phone: phone.trim() || undefined,
          lagoslifeUsername: lagoslifeUsername.trim() || undefined,
        }),
      });
      setProfile(res.profile);
      setMessage("Profile updated.");
      pushToast({ title: "Profile updated", tone: "success" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <CustomerShell>
      <div className="space-y-6 max-w-2xl">
        <div>
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-[#0B1324]">
            Account &amp; Profile
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Keep your default LagosLife username and contact details up to date.
          </p>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
        {message && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {message}
          </div>
        )}

        <Card title="Customer Details">
          <form onSubmit={handleSave} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Full Name</label>
              <input
                type="text"
                required
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#059669] focus:outline-none"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Email</label>
              <input
                type="email"
                disabled
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-500"
                value={profile?.email ?? ""}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Phone</label>
                <input
                  type="tel"
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#059669] focus:outline-none"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Default LagosLife Username
                </label>
                <input
                  type="text"
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#059669] focus:outline-none"
                  value={lagoslifeUsername}
                  onChange={(e) => setLagoslifeUsername(e.target.value)}
                />
              </div>
            </div>

            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save Changes"}
            </Button>
          </form>
        </Card>

        {profile && (
          <Card title="Attribution Status">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-slate-600">
                {profile.attributedPartner
                  ? `Referred by Partner: ${profile.attributedPartner.displayName} (${profile.attributedPartner.referralCode})`
                  : "Direct Big Ola Marketplace Customer"}
              </span>
              <StatusBadge
                label={profile.category === "CATEGORY_A_PARTNER" ? "Partner Attributed" : "Direct"}
                tone="info"
              />
            </div>
          </Card>
        )}
      </div>
    </CustomerShell>
  );
}
