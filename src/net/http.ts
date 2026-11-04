// Outbound HTTP for external data sources: timeouts, an honest User-Agent, a TTL cache in SQLite,
// and per-host pacing so we respect public APIs' usage policies (e.g. Nominatim: 1 request/second).
import type { DB } from "../db/db.ts";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export const USER_AGENT = "MediFast/3.0 (+https://github.com/Ruchin-Audichya/MediFastRX-Bot)";

export function createCache(db: DB, now: () => number = Date.now) {
  const get = db.prepare("SELECT value FROM cache WHERE key = ? AND expires_at > ?");
  const put = db.prepare("INSERT OR REPLACE INTO cache(key, value, expires_at) VALUES (?,?,?)");
  return {
    get<T>(key: string): T | undefined {
      const r = get.get(key, now()) as { value: string } | undefined;
      return r ? (JSON.parse(r.value) as T) : undefined;
    },
    set(key: string, value: unknown, ttlMs: number) { put.run(key, JSON.stringify(value), now() + ttlMs); },
    prune() { db.prepare("DELETE FROM cache WHERE expires_at <= ?").run(now()); },
  };
}
export type Cache = ReturnType<typeof createCache>;

export function createHttp(fetcher: Fetcher = fetch) {
  const lastCall = new Map<string, number>();
  const queue = new Map<string, Promise<unknown>>();
  /** GET JSON with a timeout; minGapMs spaces calls to the same host. Throws on network/HTTP errors. */
  async function getJson<T>(url: string, opts: { timeoutMs?: number; minGapMs?: number; method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<T> {
    const host = new URL(url).host;
    const run = async () => {
      const wait = (lastCall.get(host) ?? 0) + (opts.minGapMs ?? 0) - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastCall.set(host, Date.now());
      const res = await fetcher(url, {
        method: opts.method ?? "GET",
        body: opts.body,
        headers: { "user-agent": USER_AGENT, accept: "application/json", ...(opts.headers ?? {}) },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 6000),
      });
      if (!res.ok) throw new Error(`${host} answered ${res.status}`);
      return (await res.json()) as T;
    };
    // Serialize per host so pacing holds under concurrency.
    const prev = queue.get(host) ?? Promise.resolve();
    const next = prev.then(run, run);
    queue.set(host, next.catch(() => {}));
    return next;
  }
  return { getJson };
}
export type Http = ReturnType<typeof createHttp>;
