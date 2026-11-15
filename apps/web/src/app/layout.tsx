import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Manrope } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { ToastProvider } from "@/components/ui/Toast";

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const inter = Inter({
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
    "Premium gaming-fintech LagosLife currency marketplace with independent OPay payment verification and real-time order tracking.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${manrope.variable} ${inter.variable} ${jetbrainsMono.variable}`}
    >
      <body className="min-h-screen bg-[#F4F6FA] text-[#0B1324] antialiased selection:bg-emerald-100 selection:text-emerald-900">
        <AuthProvider>
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
