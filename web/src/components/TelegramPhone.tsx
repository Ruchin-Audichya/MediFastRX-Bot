import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { TelegramHtml } from "./Html.tsx";
import { Mark } from "./Logo.tsx";

export type Button = { text: string; callback_data?: string; url?: string; web_app?: { url: string } };
export type ChatMessage = { id: number; from: "bot" | "user"; text: string; html: boolean; inline: Button[][] | null; location?: { lat: number; lng: number }; photo?: boolean; date: number; edited?: number };
export type ChatSnapshot = { messages: ChatMessage[]; replyKeyboard: { text: string; request_location?: boolean }[][] | null; toast: { text: string; alert: boolean; at: number } | null };

type Props = {
  title: string;
  subtitle: string;
  chat: ChatSnapshot | null;
  quick?: { label: string; text?: string; action?: () => void }[];
  onText: (text: string) => Promise<unknown>;
  onPress: (messageId: number, data: string) => Promise<unknown>;
  onLocation?: () => Promise<unknown>;
  onPhoto?: (file: File) => Promise<unknown>;
  onLink?: (url: string) => void;
  emptyHint?: string;
};

const time = (ms: number) => new Date(ms).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

export function TelegramPhone({ title, subtitle, chat, quick, onText, onPress, onLocation, onPhoto, onLink, emptyHint }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const seen = useRef(new Map<number, number>());
  const [flash, setFlash] = useState<Set<number>>(new Set());
  const messages = chat?.messages ?? [];
  const count = messages.length;

  // Auto-scroll on new messages; flash bubbles that were edited in place (live board updates).
  useLayoutEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight });
  }, [count]);
  useEffect(() => {
    const changed = new Set<number>();
    for (const m of messages) {
      const prev = seen.current.get(m.id);
      if (prev !== undefined && m.edited && m.edited !== prev) changed.add(m.id);
      seen.current.set(m.id, m.edited ?? 0);
    }
    if (changed.size) {
      setFlash(changed);
      const t = setTimeout(() => setFlash(new Set()), 900);
      return () => clearTimeout(t);
    }
  }, [chat]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try { await fn(); } finally { setBusy(null); }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText("");
    run("text", () => onText(t));
  };
  const press = (m: ChatMessage, b: Button) => {
    if (b.callback_data) return run(`${m.id}:${b.callback_data}`, () => onPress(m.id, b.callback_data!));
    const url = b.web_app?.url ?? b.url;
    if (url) onLink ? onLink(url) : window.open(url, "_blank", "noopener");
  };
  const toastFresh = chat?.toast && Date.now() - chat.toast.at < 2600;

  return (
    <div className="phone">
      <div className="tg-head">
        <div className="tg-avatar"><Mark size={26} /></div>
        <div>
          <b>{title}</b>
          <small>{busy ? "typing…" : subtitle}</small>
        </div>
      </div>
      <div className="tg-body" ref={body} aria-live="polite">
        {!messages.length && <div className="empty-chat">{emptyHint ?? "Say hi to start."}</div>}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.from}`}>
            <div className={`bubble${flash.has(m.id) ? " flash" : ""}`}>
              {m.location ? "📍 Shared location" : m.html ? <TelegramHtml html={m.text} /> : m.text}
              <span className="meta">{m.edited ? "edited " : ""}{time(m.edited ?? m.date)}</span>
            </div>
            {m.inline && (
              <div className="kb">
                {m.inline.map((row, i) => (
                  <div className="kb-row" key={i}>
                    {row.map((b, j) => (
                      <button key={j} type="button" disabled={busy === `${m.id}:${b.callback_data}`} onClick={() => press(m, b)} title={b.text}>
                        {b.text}{b.url || b.web_app ? " ↗" : ""}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {toastFresh && <div key={chat!.toast!.at} className={`toast${chat!.toast!.alert ? " alert" : ""}`}>{chat!.toast!.text}</div>}
      {chat?.replyKeyboard && (
        <div className="reply-kb">
          {chat.replyKeyboard.flat().map((b, i) => (
            <button key={i} type="button" onClick={() => (b.request_location && onLocation ? run("loc", onLocation) : run("text", () => onText(b.text)))}>
              {b.text}
            </button>
          ))}
        </div>
      )}
      {quick && quick.length > 0 && (
        <div className="quick">
          {quick.map((q) => (
            <button key={q.label} type="button" className="chip" onClick={() => (q.action ? q.action() : run("text", () => onText(q.text!)))}>
              {q.label}
            </button>
          ))}
        </div>
      )}
      <form className="composer" onSubmit={submit}>
        {onPhoto && (
          <>
            <button type="button" className="icon" aria-label="Send a prescription photo" onClick={() => file.current?.click()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.4 11.1l-9.2 9.2a6 6 0 01-8.5-8.5l9.2-9.2a4 4 0 015.7 5.7l-9.2 9.2a2 2 0 01-2.8-2.8l8.5-8.5" /></svg>
            </button>
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) run("photo", () => onPhoto(f)); e.target.value = ""; }} />
          </>
        )}
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message" aria-label={`Message as ${title}`} maxLength={600} />
        <button type="submit" className="icon send" aria-label="Send">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.4l17.5-7.5a1 1 0 000-1.8L3.4 3.6a1 1 0 00-1.4 1.1L4 11l9 1-9 1-2 6.3a1 1 0 001.4 1.1z" /></svg>
        </button>
      </form>
    </div>
  );
}
