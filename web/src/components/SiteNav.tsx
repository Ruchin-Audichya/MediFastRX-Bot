import { Logo } from "./Logo.tsx";

/** Shared top navigation for public pages. */
export function SiteNav({ bot, current }: { bot?: string | null; current?: "home" | "medicines" | "find" }) {
  const tg = bot ? `https://t.me/${bot}` : null;
  return (
    <nav className="nav">
      <div className="wrap">
        <Logo />
        <div className="nav-links">
          <a href="/find" aria-current={current === "find" ? "page" : undefined}>Find a medicine</a>
          <a href="/#how">How it works</a>
          <a href="/medicines" aria-current={current === "medicines" ? "page" : undefined}>Medicines</a>
          <a href="/#pharmacies">For pharmacies</a>
          <a className="btn btn-light btn-sm" href="/studio">Live demo</a>
          {tg && <a className="btn btn-primary btn-sm" href={tg}>Open in Telegram</a>}
        </div>
      </div>
    </nav>
  );
}
