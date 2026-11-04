declare global {
  interface Window { Telegram?: { WebApp?: TelegramWebApp } }
}
export type TelegramWebApp = {
  initData: string;
  colorScheme: "light" | "dark";
  ready(): void;
  expand(): void;
  HapticFeedback?: { impactOccurred(s: string): void; notificationOccurred(s: string): void };
  BackButton?: { show(): void; hide(): void; onClick(f: () => void): void };
};

const PERSONA_KEY = "medifast.persona";
export function persona(): string | null {
  const q = new URLSearchParams(location.search).get("as");
  try {
    if (q) sessionStorage.setItem(PERSONA_KEY, q);
    return q ?? sessionStorage.getItem(PERSONA_KEY);
  } catch {
    return q;
  }
}
export const tg = () => (window.Telegram?.WebApp?.initData ? window.Telegram.WebApp : null);

export function authHeader(): string | null {
  const app = tg();
  if (app) return `tma ${app.initData}`;
  const p = persona();
  return p ? `studio ${p}` : null;
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T = any>(path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const auth = authHeader();
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...init,
    headers: { ...(body !== undefined && !(body instanceof Blob) ? { "content-type": "application/json" } : {}), ...(auth ? { authorization: auth } : {}), ...(init.headers ?? {}) },
    body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? "error", json?.error?.message ?? `Request failed (${res.status})`);
  return json as T;
}

/** Loads the Telegram Mini App SDK only on Mini App routes. Resolves even outside Telegram. */
export function loadTelegramSdk(): Promise<void> {
  if (window.Telegram?.WebApp) return Promise.resolve();
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "https://telegram.org/js/telegram-web-app.js";
    s.onload = s.onerror = () => {
      const app = window.Telegram?.WebApp;
      if (app?.initData) { app.ready(); app.expand(); }
      resolve();
    };
    document.head.appendChild(s);
    setTimeout(resolve, 2500);
  });
}

export const haptic = (kind: "light" | "success" | "error" = "light") => {
  const h = window.Telegram?.WebApp?.HapticFeedback;
  if (!h) return;
  kind === "light" ? h.impactOccurred("light") : h.notificationOccurred(kind);
};
