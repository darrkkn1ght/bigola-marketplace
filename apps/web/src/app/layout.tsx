import type { Metadata } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Big Ola Marketplace — Verified LagosLife Currency",
  description:
    "Modern, transparent LagosLife currency marketplace with independent OPay payment verification and partner attribution.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plusJakarta.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-screen bg-[#F8FAFC] text-[#0F172A] antialiased selection:bg-emerald-100 selection:text-emerald-900">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
