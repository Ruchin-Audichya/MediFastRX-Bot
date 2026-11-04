import { Fragment, type ReactNode } from "react";

const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENT[m]);
const TAG = /<(\/?)(b|i|code|a)(?:\s+href="([^"]*)")?>/g;

/**
 * Renders the Telegram HTML subset the bot uses (b, i, code, a) as React elements.
 * No innerHTML: unknown markup stays visible as text.
 */
export function TelegramHtml({ html }: { html: string }) {
  type Frame = { tag: string; href?: string; children: ReactNode[] };
  const root: Frame = { tag: "root", children: [] };
  const stack: Frame[] = [root];
  let last = 0, key = 0;
  for (const m of html.matchAll(TAG)) {
    if (m.index! > last) stack.at(-1)!.children.push(decode(html.slice(last, m.index)));
    last = m.index! + m[0].length;
    if (!m[1]) stack.push({ tag: m[2], href: m[3], children: [] });
    else if (stack.length > 1 && stack.at(-1)!.tag === m[2]) {
      const f = stack.pop()!;
      const k = key++;
      const el =
        f.tag === "b" ? <b key={k}>{f.children}</b>
        : f.tag === "i" ? <i key={k}>{f.children}</i>
        : f.tag === "code" ? <code key={k}>{f.children}</code>
        : /^https?:\/\//.test(f.href ?? "") ? <a key={k} href={f.href} target="_blank" rel="noreferrer">{f.children}</a>
        : <Fragment key={k}>{f.children}</Fragment>;
      stack.at(-1)!.children.push(el);
    }
  }
  if (last < html.length) stack.at(-1)!.children.push(decode(html.slice(last)));
  while (stack.length > 1) { const f = stack.pop()!; stack.at(-1)!.children.push(...f.children); }
  return <>{root.children}</>;
}
