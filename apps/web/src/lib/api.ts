"use client";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const TOKEN_KEY = "rr_access";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(typeof body === "object" && body !== null && "message" in body ? String((body as { message: unknown }).message) : `HTTP ${status}`);
  }
}

async function refreshAccessToken(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      credentials: "include", // httpOnly refresh cookie
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { accessToken: string };
    setToken(json.accessToken);
    return true;
  } catch {
    return false;
  }
}

export async function api<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !retried && (await refreshAccessToken())) {
    return api<T>(method, path, body, true);
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined") {
      setToken(null);
      window.location.href = "/login";
    }
    throw new ApiError(res.status, json);
  }
  return json as T;
}
