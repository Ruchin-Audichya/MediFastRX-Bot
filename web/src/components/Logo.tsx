export function Mark({ size = 30 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="#0b1a2b" />
      <circle cx="32" cy="32" r="21" fill="none" stroke="#19c37d" strokeWidth="3" opacity=".3" />
      <circle cx="32" cy="32" r="12.5" fill="none" stroke="#19c37d" strokeWidth="3" opacity=".65" />
      <path d="M28.5 22h7v6.5H42v7h-6.5V42h-7v-6.5H22v-7h6.5z" fill="#19c37d" />
    </svg>
  );
}
export function Logo({ dark = true }: { dark?: boolean }) {
  return (
    <a className="logo" href="/" style={{ color: dark ? "#fff" : "var(--ink)" }}>
      <Mark /> MediFast
    </a>
  );
}
