const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:4000/api/v1";

const CSRF_STORAGE_KEY = "bigola_csrf_token";
const AUTH_STORAGE_KEY = "bigola_auth_token";

function getStoredValue(key: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage.getItem(key) || window.sessionStorage.getItem(key) || undefined;
  } catch {
    return undefined;
  }
}

function setStoredValue(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value) {
      window.localStorage.setItem(key, value);
      window.sessionStorage.setItem(key, value);
    } else {
      window.localStorage.removeItem(key);
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Ignore storage access errors
  }
}

function getCsrfToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(/(?:^|;\s*)bigola_csrf=([^;]+)/);
  if (match) return decodeURIComponent(match[1]);
  return getStoredValue(CSRF_STORAGE_KEY);
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  const authToken = getStoredValue(AUTH_STORAGE_KEY);
  if (authToken && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${authToken}`);
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
    if (res.status === 401 && normalizedPath === "/auth/me") {
      setStoredValue(AUTH_STORAGE_KEY, null);
      setStoredValue(CSRF_STORAGE_KEY, null);
    }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  if ((normalizedPath === "/auth/login" || normalizedPath === "/auth/register") && typeof data?.token === "string") {
    setStoredValue(AUTH_STORAGE_KEY, data.token);
  }
  if (typeof data?.csrfToken === "string" && data.csrfToken.length > 0) {
    setStoredValue(CSRF_STORAGE_KEY, data.csrfToken);
  } else if (normalizedPath === "/auth/logout") {
    setStoredValue(AUTH_STORAGE_KEY, null);
    setStoredValue(CSRF_STORAGE_KEY, null);
  }
  return data as T;
}

