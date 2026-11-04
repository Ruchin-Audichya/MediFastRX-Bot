import { EventEmitter } from "node:events";
import type { Bot, Api } from "grammy";
import type { UserFromGetMe } from "grammy/types";

/**
 * A faithful in-process stand-in for the Telegram Bot API. The real bot middleware
 * runs unchanged against it; Demo Studio renders the resulting chats. No token, no
 * network. Only the methods MediFast uses are implemented, and anything else fails
 * loudly so gaps are visible instead of silently ignored.
 */
export type StudioButton = { text: string; callback_data?: string; url?: string; web_app?: { url: string } };
export type StudioMessage = {
  id: number; chatId: number; from: "bot" | "user"; text: string; html: boolean;
  inline: StudioButton[][] | null; location?: { lat: number; lng: number }; photo?: boolean;
  date: number; edited?: number;
};
type Chat = { messages: StudioMessage[]; replyKeyboard: { text: string; request_location?: boolean }[][] | null; toast?: { text: string; alert: boolean; at: number } };

export const STUDIO_BOT: UserFromGetMe = {
  id: 7_000_000_001, is_bot: true, first_name: "MediFast", username: "MediFastDemoBot",
  can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false,
} as UserFromGetMe;

export function createFakeTelegram() {
  const chats = new Map<number, Chat>();
  const files = new Map<string, { data: Buffer; mime: string }>();
  const events = new EventEmitter();
  events.setMaxListeners(100);
  let messageId = 1000, updateId = 1, fileN = 1;

  const chat = (id: number) => {
    let c = chats.get(id);
    if (!c) chats.set(id, (c = { messages: [], replyKeyboard: null }));
    return c;
  };
  const changed = (chatId: number) => events.emit("change", chatId);

  function store(chatId: number, m: Omit<StudioMessage, "id" | "chatId" | "date">) {
    const msg: StudioMessage = { id: ++messageId, chatId, date: Date.now(), ...m };
    const c = chat(chatId);
    c.messages.push(msg);
    if (c.messages.length > 200) c.messages.splice(0, c.messages.length - 200);
    changed(chatId);
    return msg;
  }
  const asTelegram = (m: StudioMessage) => ({
    message_id: m.id, date: Math.floor(m.date / 1000), chat: { id: m.chatId, type: "private" as const, first_name: "Studio" },
    from: STUDIO_BOT, text: m.text,
  });
  const markup = (chatId: number, rm: any): StudioButton[][] | null => {
    if (!rm) return null;
    if (rm.remove_keyboard) chat(chatId).replyKeyboard = null;
    if (rm.keyboard) chat(chatId).replyKeyboard = rm.keyboard.map((row: any[]) => row.map((b) => (typeof b === "string" ? { text: b } : b)));
    return rm.inline_keyboard ?? null;
  };

  const methods: Record<string, (p: any) => unknown> = {
    getMe: () => STUDIO_BOT,
    sendMessage: (p) => asTelegram(store(Number(p.chat_id), { from: "bot", text: p.text, html: p.parse_mode === "HTML", inline: markup(Number(p.chat_id), p.reply_markup) })),
    editMessageText: (p) => {
      const c = chat(Number(p.chat_id));
      const m = c.messages.find((x) => x.id === p.message_id);
      if (!m) throw Object.assign(new Error("Bad Request: message to edit not found"), { description: "Bad Request: message to edit not found" });
      const inline = p.reply_markup?.inline_keyboard ?? null;
      if (m.text === p.text && JSON.stringify(m.inline) === JSON.stringify(inline))
        throw Object.assign(new Error("Bad Request: message is not modified"), { description: "Bad Request: message is not modified" });
      Object.assign(m, { text: p.text, html: p.parse_mode === "HTML", inline, edited: Date.now() });
      changed(m.chatId);
      return asTelegram(m);
    },
    editMessageReplyMarkup: (p) => {
      const m = chat(Number(p.chat_id)).messages.find((x) => x.id === p.message_id);
      if (m) { m.inline = p.reply_markup?.inline_keyboard ?? null; changed(m.chatId); }
      return true;
    },
    answerCallbackQuery: (p) => {
      const [chatId] = String(p.callback_query_id).split(":");
      if (p.text) { chat(Number(chatId)).toast = { text: p.text, alert: !!p.show_alert, at: Date.now() }; changed(Number(chatId)); }
      return true;
    },
    sendChatAction: () => true,
    deleteMessage: (p) => {
      const c = chat(Number(p.chat_id));
      c.messages = c.messages.filter((m) => m.id !== p.message_id);
      changed(Number(p.chat_id));
      return true;
    },
    getFile: (p) => ({ file_id: p.file_id, file_unique_id: p.file_id, file_path: p.file_id, file_size: files.get(p.file_id)?.data.length }),
    setMyCommands: () => true,
  };

  /** grammY API transformer: every outgoing call is answered locally. */
  function attach(api: Api) {
    api.config.use(async (_prev, method, payload) => {
      const fn = methods[method];
      if (!fn) throw new Error(`Studio transport does not implement ${method}`);
      try {
        return { ok: true, result: fn(payload ?? {}) } as any;
      } catch (e: any) {
        return { ok: false, error_code: 400, description: e.description ?? String(e) } as any;
      }
    });
  }

  type Persona = { id: number; first_name: string };
  const userMessage = (p: Persona, extra: object) => {
    const base = { message_id: ++messageId, date: Math.floor(Date.now() / 1000), from: { id: p.id, is_bot: false, first_name: p.first_name }, chat: { id: p.id, type: "private" as const, first_name: p.first_name } };
    return { ...base, ...extra };
  };

  function input(bot: Bot<any>) {
    const deliver = (update: any) => bot.handleUpdate({ update_id: ++updateId, ...update });
    return {
      text(p: Persona, text: string) {
        const command = text.match(/^\/\w+/);
        const msg = userMessage(p, { text, entities: command ? [{ type: "bot_command", offset: 0, length: command[0].length }] : undefined });
        store(p.id, { from: "user", text, html: false, inline: null });
        if (chat(p.id).replyKeyboard && text) chat(p.id).replyKeyboard = null;
        return deliver({ message: msg });
      },
      location(p: Persona, lat: number, lng: number) {
        store(p.id, { from: "user", text: "📍 Location", html: false, inline: null, location: { lat, lng } });
        chat(p.id).replyKeyboard = null;
        return deliver({ message: userMessage(p, { location: { latitude: lat, longitude: lng } }) });
      },
      photo(p: Persona, data: Buffer, mime: string) {
        const fileId = `studio-file-${fileN++}`;
        files.set(fileId, { data, mime });
        store(p.id, { from: "user", text: "📷 Prescription photo", html: false, inline: null, photo: true });
        return deliver({ message: userMessage(p, { photo: [{ file_id: fileId, file_unique_id: fileId, width: 1000, height: 1400, file_size: data.length }] }) });
      },
      press(p: Persona, messageId: number, data: string) {
        const m = chat(p.id).messages.find((x) => x.id === messageId);
        if (!m) return Promise.resolve();
        return deliver({
          callback_query: {
            id: `${p.id}:${updateId}`, from: { id: p.id, is_bot: false, first_name: p.first_name },
            message: asTelegram(m), chat_instance: String(p.id), data,
          },
        });
      },
    };
  }

  return {
    attach, input, events,
    file: (id: string) => files.get(id),
    snapshot: (chatId: number) => {
      const c = chat(chatId);
      return { messages: c.messages, replyKeyboard: c.replyKeyboard, toast: c.toast ?? null };
    },
    reset() { chats.clear(); files.clear(); },
  };
}
export type FakeTelegram = ReturnType<typeof createFakeTelegram>;
