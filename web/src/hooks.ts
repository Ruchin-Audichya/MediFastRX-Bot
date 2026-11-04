import { useCallback, useEffect, useRef, useState } from "react";
import { api, authHeader } from "./api.ts";

/** Fetch + refetch on server-sent events. Events carry ids only; we always refetch. */
export function useLive<T>(path: string | null, filter?: (type: string, data: any) => boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const load = useCallback(async () => {
    if (!path) return;
    try { setData(await api<T>(path)); setError(null); } catch (e: any) { setError(e.message); }
  }, [path]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const auth = authHeader();
    if (!path || !auth) return;
    const es = new EventSource(`/api/events?auth=${encodeURIComponent(auth)}`);
    const onEvent = (type: string) => (e: MessageEvent) => {
      if (filter && !filter(type, JSON.parse(e.data))) return;
      clearTimeout(timer.current);
      timer.current = window.setTimeout(load, 120);
    };
    es.addEventListener("ask", onEvent("ask"));
    es.addEventListener("reservation", onEvent("reservation"));
    es.onopen = () => load(); // re-sync after reconnects
    return () => { es.close(); clearTimeout(timer.current); };
  }, [path, load, filter]);
  return { data, error, reload: load };
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export const km = (m: number) => (m < 1000 ? `${Math.max(50, Math.round(m / 50) * 50)} m` : `${(m / 1000).toFixed(1)} km`);
export const secs = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)} min`);
export const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
