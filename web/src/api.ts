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
const KEY = "medifast.studioKey";
export function studioKey(): string {
  try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; }
}
export function setStudioKey(k: string) {
  try { localStorage.setItem(KEY, k); } catch {}
}
/** Query suffix for EventSource URLs, which can't send headers. */
export const keyQuery = (sep = "?") => (studioKey() ? `${sep}key=${encodeURIComponent(studioKey())}` : "");

export const tg = () => (window.Telegram?.WebApp?.initData ? window.Telegram.WebApp : null);

const WEB_KEY = "medifast.webToken";
function webToken(): string | null {
  try { return localStorage.getItem(WEB_KEY); } catch { return null; }
}
/** Anonymous website session (no Telegram needed). The token never leaves this browser except to our API. */
export async function ensureWebSession(): Promise<void> {
  if (tg() || persona() || webToken()) return;
  const { token } = await api<{ token: string }>("/web/session", {});
  try { localStorage.setItem(WEB_KEY, token); } catch {}
}

export function resetWebSession() {
  try { localStorage.removeItem(WEB_KEY); } catch {}
}

export function authHeader(): string | null {
  const app = tg();
  if (app) return `tma ${app.initData}`;
  const p = persona();
  if (p) return `studio ${p}`;
  const w = webToken();
  return w ? `web ${w}` : null;
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
    headers: { ...(body !== undefined && !(body instanceof Blob) ? { "content-type": "application/json" } : {}), ...(auth ? { authorization: auth } : {}), ...(studioKey() ? { "x-studio-key": studioKey() } : {}), ...(init.headers ?? {}) },
    body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? "error", json?.error?.message ?? `Request failed (${res.status})`);
  return json as T;
}

/** Loads the Telegram Mini App SDK only on Mini App routes. Resolves even outside Telegram. */
export function loadTelegramSdk(): Promise<void> {
  if (window.Telegram?.WebApp) return Promise.resolve();
  // Website visitors and Studio personas aren't inside Telegram: don't make them wait for its SDK.
  // Telegram always launches Mini Apps with tgWebApp… parameters in the URL hash.
  if (!location.hash.includes("tgWebApp") && (persona() || webToken())) return Promise.resolve();
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
