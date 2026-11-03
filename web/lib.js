export const signature = (m) =>
  [m.strength, m.form].filter(Boolean).join(" · ") ||
  "Strength and form not supplied";
export function readStore(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return Array.isArray(value)
      ? value.filter((x) => x && typeof x === "object").slice(0, 100)
      : fallback;
  } catch {
    return fallback;
  }
}
export async function api(url, { signal, ...options } = {}) {
  const response = await fetch(url, {
    ...options,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(12000)])
      : AbortSignal.timeout(12000),
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw Error(
      "The local server is not responding. Check that npm run dev is running.",
    );
  }
  if (!response.ok) throw Error(data.error || "Please try again.");
  return data;
}
