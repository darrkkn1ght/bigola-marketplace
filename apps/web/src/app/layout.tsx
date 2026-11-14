import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Big Ola Marketplace — LagosLife Currency Distribution",
  description: "Dedicated LagosLife currency marketplace and distribution platform for bigola2823.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased selection:bg-emerald-500/30">{children}</body>
    </html>
  );
}

