import { apiRequest } from "./api";

export const REFERRAL_STORAGE_KEY = "bigola_referral_code";

interface ReferralValidationResponse {
  valid: boolean;
  firstReferralPreserved?: boolean;
  referralCode?: string;
  partnerDisplayName?: string;
}

export function getStoredReferralCode(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(REFERRAL_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function clearStoredReferralCode(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(REFERRAL_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

export function extractRefFromSearch(search: string): string | null {
  const ref = new URLSearchParams(search).get("ref")?.trim();
  return ref && ref.length > 0 ? ref : null;
}

/**
 * Captures and validates a `?ref=` query parameter against GET /api/v1/referrals/validate/:code.
 * - Sets the signed HttpOnly `bigola_ref` cookie on the API when valid.
 * - Preserves the first valid referral code in localStorage (never overwriting with later/invalid codes).
 */
export async function captureReferralFromUrl(): Promise<string | null> {
  if (typeof window === "undefined") return null;

  const existing = getStoredReferralCode();
  const rawRef = extractRefFromSearch(window.location.search);
  if (!rawRef) {
    return existing || null;
  }

  try {
    const res = await apiRequest<ReferralValidationResponse>(
      `/referrals/validate/${encodeURIComponent(rawRef)}`
    );
    if (res.valid && res.referralCode) {
      // First valid referral wins permanently across both cookie and localStorage.
      const winningCode = existing || res.referralCode;
      if (!existing) {
        try {
          window.localStorage.setItem(REFERRAL_STORAGE_KEY, winningCode);
        } catch {
          // ignore storage errors
        }
      }
      return winningCode;
    }
  } catch {
    // Invalid or inactive referral code: do not store or overwrite existing attribution.
  }

  return existing || null;
}
