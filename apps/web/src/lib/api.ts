const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:4000/api/v1";

const CSRF_STORAGE_KEY = "bigola_csrf_token";

function getCsrfToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(/(?:^|;\s*)bigola_csrf=([^;]+)/);
  if (match) return decodeURIComponent(match[1]);
  try {
    return (
      window.localStorage.getItem(CSRF_STORAGE_KEY) ||
      window.sessionStorage.getItem(CSRF_STORAGE_KEY) ||
      undefined
    );
  } catch {
    return undefined;
  }
}

function setStoredCsrfToken(token: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (token) {
      window.localStorage.setItem(CSRF_STORAGE_KEY, token);
      window.sessionStorage.setItem(CSRF_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(CSRF_STORAGE_KEY);
      window.sessionStorage.removeItem(CSRF_STORAGE_KEY);
    }
  } catch {
    // Ignore storage access errors
  }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  const method = (init.method ?? "GET").toUpperCase();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    const csrf = getCsrfToken();
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }

  const normalizedPath = path.startsWith("/api/v1/")
    ? path.slice("/api/v1".length)
    : path.startsWith("/")
      ? path
      : `/${path}`;

  const res = await fetch(`${API_BASE}${normalizedPath}`, {
    ...init,
    headers,
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  if (typeof data?.csrfToken === "string" && data.csrfToken.length > 0) {
    setStoredCsrfToken(data.csrfToken);
  } else if (normalizedPath === "/auth/logout") {
    setStoredCsrfToken(null);
  }
  return data as T;
}

