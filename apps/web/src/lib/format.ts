import { ONE_TRILLION } from "@bigola/shared";

export function formatNaira(koboInput: string | bigint | number): string {
  const kobo = typeof koboInput === "bigint" ? koboInput : BigInt(koboInput || "0");
  const isNeg = kobo < 0n;
  const abs = isNeg ? -kobo : kobo;
  const naira = Number(abs) / 100;
  const formatted = naira.toLocaleString("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${isNeg ? "-" : ""}₦${formatted}`;
}

const ONE_BILLION = 1_000_000_000n;

export function formatTrillions(rawAmount: string | bigint): string {
  const amount = typeof rawAmount === "bigint" ? rawAmount : BigInt(rawAmount || "0");
  if (amount === 0n) return "0T";
  const sign = amount < 0n ? "-" : "";
  const abs = amount < 0n ? -amount : amount;
  const totalBillions = abs / ONE_BILLION;
  const wholeT = abs / ONE_TRILLION;
  const remBillions = totalBillions % 1_000n;
  if (remBillions === 0n) {
    return `${sign}${wholeT.toLocaleString("en-NG")}T`;
  }
  const fracStr = remBillions.toString().padStart(3, "0").replace(/0+$/, "");
  return `${sign}${wholeT.toLocaleString("en-NG")}.${fracStr}T (${sign}${totalBillions.toLocaleString("en-NG")}B)`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-NG", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export type BadgeTone = "success" | "warning" | "danger" | "info" | "neutral";

const ORDER_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  AWAITING_PAYMENT: { label: "Awaiting OPay Transfer", tone: "warning" },
  PAYMENT_SUBMITTED: { label: "Proof Submitted — Under Review", tone: "info" },
  PROOF_SUBMITTED: { label: "Proof Submitted — Under Review", tone: "info" },
  PAYMENT_EXCEPTION_REVIEW: { label: "Manual Review Required", tone: "warning" },
  PAYMENT_VERIFIED: { label: "Payment Verified", tone: "success" },
  READY_FOR_FULFILMENT: { label: "Verified — Ready for Delivery", tone: "success" },
  PARTIALLY_FULFILLED: { label: "Partially Fulfilled", tone: "info" },
  DISBURSED: { label: "Delivered", tone: "success" },
  COMPLETED: { label: "Completed", tone: "success" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  EXPIRED: { label: "Reservation Expired", tone: "danger" },
  REFUNDED: { label: "Refunded / Reversed", tone: "danger" },
};

export function humanizeOrderStatus(status: string): { label: string; tone: BadgeTone } {
  return ORDER_STATUS_META[status] ?? { label: status.replaceAll("_", " "), tone: "neutral" };
}

export function roleHomePath(role: string): string {
  if (role === "OWNER") return "/owner";
  if (role === "OPS_ADMIN") return "/ops";
  if (role === "PARTNER") return "/partner";
  return "/marketplace";
}
