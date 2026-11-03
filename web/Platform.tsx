import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from "react";
import dynamic from "next/dynamic";
import {
  ArrowRight,
  Check,
  Clock,
  FileText,
  MapPin,
  Mic,
  ScanLine,
  Store,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
type User = {
  id: string;
  name: string;
  email: string;
  role: "customer" | "pharmacy" | "admin";
  demo: boolean;
};
export type Medicine = {
  id: string;
  name: string;
  generic?: string;
  strength?: string;
  form?: string;
  quantity?: number;
};
export async function platformApi(path: string, options: RequestInit = {}) {
  const form = options.body instanceof FormData;
  const response = await fetch("/api/platform" + path, {
    ...options,
    headers: {
      ...(!form ? { "Content-Type": "application/json" } : {}),
      "X-MediFast": "app",
      ...options.headers,
    },
    signal: options.signal || AbortSignal.timeout(form ? 100000 : 12000),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw Error("The server did not respond. Please retry.");
  }
  if (!response.ok)
    throw Error(data.error || "Could not complete that action.");
  return data;
}
const Context = createContext<any>(null);
export function PlatformProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null),
    [mode, setMode] = useState("demo"),
    [basket, setBasket] = useState<Medicine[]>([]),
    [prescriptionId, setPrescriptionId] = useState<string | null>(null),
    [version, setVersion] = useState(0),
    [connected, setConnected] = useState(false),
    [ready, setReady] = useState(false);
  useEffect(() => {
    platformApi("/session")
      .then((d) => {
        setUser(d.user);
        setMode(d.mode);
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    if (!user) return;
    const events = new EventSource("/api/platform/events");
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.addEventListener("update", () => setVersion((v) => v + 1));
    return () => {
      events.close();
      setConnected(false);
    };
  }, [user?.id]);
  async function logout() {
    await platformApi("/auth/logout", { method: "POST" });
    setUser(null);
    setBasket([]);
    setPrescriptionId(null);
  }
  return (
    <Context.Provider
      value={{
        user,
        setUser,
        mode,
        ready,
        basket,
        setBasket,
        prescriptionId,
        setPrescriptionId,
        version,
        connected,
        logout,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export const usePlatform = () => useContext(Context);
export function LiveBadge() {
  const p = usePlatform();
  return (
    <span className={`live-badge ${p.connected ? "connected" : ""}`}>
      <i />
      {p.connected
        ? "Live updates connected"
        : "Reconnecting · refresh available"}
    </span>
  );
}
function useData(path: string, enabled = true) {
  const p = usePlatform(),
    [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    platformApi(path, { signal: controller.signal })
      .then(setData)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, [path, enabled, p.version, refresh]);
  return {
    data,
    error,
    reload: () => {
      setError("");
      setRefresh((v) => v + 1);
    },
  };
}
export function AuthScreen({ navigate }: { navigate: (s: string) => void }) {
  const p = usePlatform(),
    [register, setRegister] = useState(false),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [name, setName] = useState(""),
    [role, setRole] = useState("customer"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [deleteConfirm, setDeleteConfirm] = useState(false);
  async function submit(
    e: any,
    credentials?: { email: string; password: string },
  ) {
    e?.preventDefault();
    setBusy(true);
    setError("");
    try {
      const d = await platformApi(
        register && !credentials ? "/auth/register" : "/auth/login",
        {
          method: "POST",
          body: JSON.stringify(credentials || { email, password, name, role }),
        },
      );
      p.setUser(d.user);
      navigate(
        d.user.role === "pharmacy"
          ? "operator"
          : d.user.role === "admin"
            ? "admin"
            : "partners",
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (p.user)
    return (
      <section className="platform-screen">
        <p className="eyebrow">YOUR ACCOUNT</p>
        <h1>
          Hello, <em>{p.user.name}.</em>
        </h1>
        <p>
          {p.user.email} · {p.user.role}
        </p>
        <button
          className="secondary"
          onClick={async () => {
            await p.logout();
            navigate("home");
          }}
        >
          <LogOut size={17} />
          Sign out
        </button>
        {p.user.role === "customer" && (
          <div className="desk-panel account-delete">
            <h2>Your data, your choice</h2>
            <p>
              Delete your uploads from the scanner. Deleting your account
              cancels active requests and anonymizes your account. Minimal
              request and audit records remain for this local experiment.
            </p>
            <button
              className="text-button"
              onClick={() => setDeleteConfirm(true)}
            >
              Delete my account
            </button>
            {deleteConfirm && (
              <button
                className="secondary"
                onClick={async () => {
                  try {
                    await platformApi("/account", { method: "DELETE" });
                    p.setUser(null);
                    navigate("home");
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
              >
                Confirm account deletion
              </button>
            )}
          </div>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
    );
  return (
    <section className="auth-layout">
      <div>
        <p className="eyebrow">FROM SEARCH TO A REAL CONVERSATION</p>
        <h1>
          A name on a pack.
          <br />
          <em>A pharmacy that responds.</em>
        </h1>
        <p>
          Your requests belong to you. Sign in to ask a participating pharmacy,
          scan a prescription, and follow pickup updates.
        </p>
        {p.mode === "demo" && (
          <div className="demo-login">
            <span className="tag">EXPLICIT DEMO MODE</span>
            <h2>Try both sides of the counter.</h2>
            <p>
              Fictional stores and stock. Open a second browser profile for the
              pharmacy to watch updates reach the customer.
            </p>
            {["customer", "pharmacy", "admin"].map((r) => (
              <button
                disabled={busy}
                key={r}
                className="secondary"
                onClick={() =>
                  submit(null, {
                    email: `${r}@medifast.demo`,
                    password: "DemoPass!2026",
                  })
                }
              >
                Demo {r} <ArrowRight size={16} />
              </button>
            ))}
            <small>Local demo password: DemoPass!2026</small>
          </div>
        )}
      </div>
      <form className="auth-card" onSubmit={submit}>
        <h2>{register ? "Create your account" : "Welcome back"}</h2>
        {error && (
          <div role="alert" className="notice error">
            {error}
          </div>
        )}
        {register && (
          <label>
            Your name
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
          </label>
        )}
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={register ? "new-password" : "current-password"}
            required
            minLength={register ? 12 : 1}
            maxLength={128}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {register && (
          <label>
            Account type
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="customer">Customer</option>
              <option value="pharmacy">
                Pharmacy operator — approval required
              </option>
            </select>
          </label>
        )}
        <button disabled={busy} className="primary">
          {busy ? "One moment…" : register ? "Create account" : "Sign in"}{" "}
          <ArrowRight size={16} />
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => setRegister(!register)}
        >
          {register
            ? "Already registered? Sign in"
            : "New here? Create account"}
        </button>
      </form>
    </section>
  );
}
export function VoiceButton({ onText }: { onText: (text: string) => void }) {
  const [language, setLanguage] = useState("en-IN"),
    [message, setMessage] = useState(""),
    [listening, setListening] = useState(false);
  const current = useRef<any>(null);
  useEffect(() => () => current.current?.abort(), []);
  function start() {
    const Speech =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!Speech) {
      setMessage(
        "Voice input is not supported in this browser. Type your search instead.",
      );
      return;
    }
    const recognition = new Speech();
    current.current = recognition;
    recognition.lang = language;
    recognition.interimResults = false;
    recognition.onstart = () => setListening(true);
    recognition.onend = () => setListening(false);
    recognition.onerror = () => {
      setListening(false);
      setMessage(
        "Voice permission or service unavailable. You can still type.",
      );
    };
    recognition.onresult = (e: any) => {
      onText(e.results[0][0].transcript);
      setMessage("Check the transcript, then press search.");
    };
    recognition.start();
  }
  return (
    <div className="voice-control">
      <select
        aria-label="Voice language"
        value={language}
        onChange={(e) => setLanguage(e.target.value)}
      >
        <option value="en-IN">English / Hinglish</option>
        <option value="hi-IN">हिन्दी</option>
      </select>
      <button className="text-button" onClick={start} disabled={listening}>
        <Mic size={16} />
        {listening ? "Listening…" : "Speak a medicine name"}
      </button>
      {message && (
        <small role="status">
          {message} Your browser may use its online speech service.
        </small>
      )}
    </div>
  );
}
const Map = dynamic(() => import("./PartnerMap"), {
  ssr: false,
  loading: () => <div className="map-loading">Loading map…</div>,
});
export function PartnersScreen({
  navigate,
}: {
  navigate: (s: string) => void;
}) {
  const p = usePlatform(),
    [center, setCenter] = useState({ lat: 26.9124, lng: 75.7873 }),
    [area, setArea] = useState("Jaipur"),
    [choices, setChoices] = useState<any[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [map, setMap] = useState(false);
  const keys = useRef<Record<string, string>>({});
  const ids = p.basket.map((m: Medicine) => m.id).join(","),
    {
      data,
      error: loadError,
      reload,
    } = useData(
      `/partners?ids=${encodeURIComponent(ids)}&lat=${center.lat}&lng=${center.lng}`,
    );
  async function searchArea(e: any) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/places?q=" + encodeURIComponent(area));
      const d = await r.json();
      if (!r.ok) throw Error(d.error);
      if (d.items.length === 1) setCenter(d.items[0]);
      else setChoices(d.items);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function locate() {
    if (!navigator.geolocation) {
      setError("Location unavailable. Search an area instead.");
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCenter({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setBusy(false);
      },
      () => {
        setError("Location wasn’t shared. Search an area instead.");
        setBusy(false);
      },
      { timeout: 8000 },
    );
  }
  async function request(id: string) {
    if (!p.user) {
      navigate("account");
      return;
    }
    setBusy(true);
    setError("");
    const payload = {
      pharmacyId: id,
      items: p.basket.map((m: Medicine) => ({
        medicineId: m.id,
        quantity: m.quantity || 1,
      })),
      prescriptionId: p.prescriptionId,
    };
    const signature = JSON.stringify(payload);
    keys.current[signature] ||= crypto.randomUUID();
    try {
      await platformApi("/requests", {
        method: "POST",
        headers: { "Idempotency-Key": keys.current[signature] },
        body: signature,
      });
      navigate("requests");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="platform-screen">
      <p className="eyebrow">FIND MY PACK · PARTICIPATING PHARMACIES</p>
      <h1>
        From “near me”
        <br />
        <em>to “ready for you”.</em>
      </h1>
      <p>
        Ask a pharmacy about your exact medicines. Every request needs
        pharmacist review before confirmation.
      </p>
      <div className="mode-banner">
        {p.mode === "demo"
          ? "DEMO PARTNERS · Fictional shops and sample stock. No real dispensing or collection."
          : "PARTICIPATING PARTNERS · Approved business profiles. Inventory is partner-managed and must be fresh."}
        <button className="text-button" onClick={() => navigate("pharmacies")}>
          Browse real map listings <ArrowRight size={15} />
        </button>
      </div>
      <div className="basket-bar">
        <div>
          <h2>Your confirmed list</h2>
          {p.basket.length ? (
            p.basket.map((m: Medicine) => (
              <div className="basket-item" key={m.id}>
                <span>
                  <strong>{m.name}</strong> {m.strength} · {m.form}
                </span>
                <label>
                  Packs
                  <input
                    aria-label={`Packs of ${m.name}`}
                    type="number"
                    min={1}
                    max={20}
                    value={m.quantity || 1}
                    onChange={(e) =>
                      p.setBasket(
                        p.basket.map((x: Medicine) =>
                          x.id === m.id
                            ? { ...x, quantity: Number(e.target.value) }
                            : x,
                        ),
                      )
                    }
                  />
                </label>
                <button
                  aria-label={`Remove ${m.name} from request`}
                  onClick={() =>
                    p.setBasket(p.basket.filter((x: Medicine) => x.id !== m.id))
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))
          ) : (
            <p>
              Search and confirm a medicine, or scan a prescription to build a
              list.
            </p>
          )}
          {p.prescriptionId && (
            <p className="small">
              Prescription attached for the selected pharmacy’s review.{" "}
              <button
                className="text-button"
                onClick={() => p.setPrescriptionId(null)}
              >
                Detach
              </button>
            </p>
          )}
        </div>
        <button className="secondary" onClick={() => navigate("home")}>
          Add a medicine
        </button>
        <button className="secondary" onClick={() => navigate("scanner")}>
          <ScanLine size={17} />
          Scan a list
        </button>
      </div>
      <form className="partner-location" onSubmit={searchArea}>
        <label>
          Area and city
          <input
            value={area}
            onChange={(e) => setArea(e.target.value)}
            maxLength={100}
          />
        </label>
        <button className="primary" disabled={busy}>
          Search area
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={locate}
        >
          <MapPin size={16} />
          Use my location
        </button>
        <button
          className="text-button"
          type="button"
          onClick={() => setMap(!map)}
        >
          {map ? "Hide map" : "Show map"}
        </button>
      </form>
      {choices.map((c, i) => (
        <button
          key={i}
          className="secondary"
          onClick={() => {
            setCenter(c);
            setChoices([]);
          }}
        >
          {c.label}
        </button>
      ))}
      {(error || loadError) && (
        <div role="alert" className="notice error">
          {error || loadError}
        </div>
      )}
      {map && data && <Map center={center} items={data.items} />}
      <div className="section-top">
        <h2>{data?.items.length || 0} participating pharmacies within 25 km</h2>
        <button className="text-button" onClick={reload}>
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>
      <div className="partner-grid">
        {data?.items.map((shop: any) => (
          <article key={shop.id} className="partner-card">
            <div className="partner-cover">
              <Store size={42} />
              <span>
                {shop.demo ? "FICTIONAL DEMO PARTNER" : "APPROVED PARTNER"}
              </span>
            </div>
            <div className="partner-body">
              <div className="section-top">
                <h2>{shop.name}</h2>
                <span>{shop.distanceKm.toFixed(1)} km</span>
              </div>
              <p>{shop.address}</p>
              <p className="small muted">
                Listed hours: {shop.hours || "Not supplied"} · opening status
                unverified
              </p>
              {shop.items.map((item: any) => {
                const m = p.basket.find(
                  (m: Medicine) => m.id === item.medicineId,
                );
                return (
                  <div className="availability-item" key={item.medicineId}>
                    <strong>
                      {m?.name} {m?.strength}
                    </strong>
                    <span className={`availability ${item.status}`}>
                      {shop.demo ? "Demo · " : ""}
                      {item.status.replaceAll("_", " ")}
                    </span>
                    <small>
                      {item.unit || "Pack not supplied"}
                      {item.price != null
                        ? ` · INR ${item.price} / listed unit`
                        : ""}
                    </small>
                    <small>
                      {item.updatedAt
                        ? `Updated ${new Date(item.updatedAt).toLocaleString()}`
                        : "No inventory update"}{" "}
                      · {item.source}
                    </small>
                  </div>
                );
              })}
              <p className="small">
                {shop.fulfilsAll
                  ? "All selected products have a fresh positive stock report."
                  : "Some products may be unknown or unavailable. The pharmacy must respond."}{" "}
                Pack size and quantity will be checked before confirmation.
              </p>
              <button
                className="primary"
                disabled={
                  busy ||
                  !p.basket.length ||
                  (p.user && p.user.role !== "customer")
                }
                onClick={() => request(shop.id)}
              >
                Request availability <ArrowRight size={17} />
              </button>
              {shop.phone && (
                <a
                  className="text-button"
                  href={`tel:${shop.phone.replace(/[^+\d]/g, "")}`}
                >
                  Call pharmacy
                </a>
              )}
              {!shop.demo && (
                <a
                  className="text-button"
                  href={`https://www.google.com/maps/dir/?api=1&destination=${shop.lat},${shop.lng}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Directions
                </a>
              )}
            </div>
          </article>
        ))}
      </div>
      {data && !data.items.length && (
        <div className="empty-state">
          <h2>No participating pharmacy here yet.</h2>
          <p>
            Real map listings can still help you find a phone number. Stock
            there remains unknown.
          </p>
          <button className="secondary" onClick={() => navigate("pharmacies")}>
            Find directory listings
          </button>
        </div>
      )}
    </section>
  );
}
const labels: Record<string, string> = {
  submitted: "Submitted",
  reviewing: "Pharmacy reviewing",
  confirmed: "Confirmed",
  preparing: "Preparing",
  ready: "Ready for pickup",
  completed: "Completed",
  cancelled: "Cancelled",
  rejected: "Rejected",
  expired: "Expired",
  unavailable: "Unavailable",
};
export function RequestsScreen({
  operator = false,
  navigate,
}: {
  operator?: boolean;
  navigate: (s: string) => void;
}) {
  const p = usePlatform(),
    { data, error, reload } = useData("/requests", !!p.user);
  if (!p.user) return <SignInGate navigate={navigate} />;
  return (
    <section className="platform-screen">
      <div className="section-top">
        <div>
          <p className="eyebrow">
            {operator ? "YOUR PHARMACY INBOX" : "MY REQUESTS"}
          </p>
          <h1>
            {operator ? "The next person" : "A little less"}
            <br />
            <em>{operator ? "you can help." : "waiting and wondering."}</em>
          </h1>
        </div>
        <LiveBadge />
      </div>
      <p>
        Persistent requests, with updates from the pharmacy. Availability
        requests are not payments, deliveries or dispensing approvals.
      </p>
      <button className="text-button" onClick={reload}>
        <RefreshCw size={16} />
        Refresh requests
      </button>
      {error && (
        <div role="alert" className="notice error">
          {error}
        </div>
      )}
      {data?.items.map((r: any) => (
        <RequestCard
          key={r.id}
          request={r}
          operator={operator}
          reload={reload}
        />
      ))}
      {data && !data.items.length && (
        <div className="empty-state">
          <FileText size={32} />
          <h2>No requests yet.</h2>
          <p>
            {operator
              ? "Customer requests will arrive here automatically."
              : "Confirm a medicine and choose a participating pharmacy to begin."}
          </p>
          {!operator && (
            <button className="primary" onClick={() => navigate("home")}>
              Find a medicine
            </button>
          )}
        </div>
      )}
    </section>
  );
}
export function SignInGate({ navigate }: { navigate: (s: string) => void }) {
  return (
    <div className="empty-state">
      <ShieldCheck size={36} />
      <h1>
        Your information.
        <br />
        <em>Your account.</em>
      </h1>
      <p>Sign in to use this private workspace.</p>
      <button className="primary" onClick={() => navigate("account")}>
        Sign in or try demo
      </button>
    </div>
  );
}
function RequestCard({
  request: r,
  operator,
  reload,
}: {
  request: any;
  operator: boolean;
  reload: () => void;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reviewed, setReviewed] = useState(false),
    [note, setNote] = useState("");
  const actions: Record<string, string[]> = {
    submitted: ["reviewing", "rejected", "unavailable"],
    reviewing: ["confirmed", "rejected", "unavailable"],
    confirmed: ["preparing", "cancelled"],
    preparing: ["ready", "cancelled"],
    ready: ["completed", "cancelled"],
  };
  async function act(status: string) {
    setBusy(true);
    setError("");
    try {
      await platformApi("/requests/" + r.id, {
        method: "PATCH",
        body: JSON.stringify({
          status,
          revision: r.revision,
          reviewed,
          reviewNote: note,
        }),
      });
      reload();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="request-card">
      <div className="section-top">
        <div>
          <span className="eyebrow">
            {r.pharmacy.demo ? "DEMO REQUEST" : "AVAILABILITY REQUEST"} ·{" "}
            {r.id.slice(0, 8)}
          </span>
          <h2>{r.pharmacy.name}</h2>
        </div>
        <span className={`status-pill status-${r.status}`}>
          {labels[r.status]}
        </span>
      </div>
      <div className="request-items">
        {r.items.map((m: any) => (
          <div key={m.medicineId}>
            <strong>
              {m.name} {m.strength}
            </strong>
            <span>
              {m.form} · {m.quantity} pack(s){m.unit ? ` · ${m.unit}` : ""}
              {m.price != null ? ` · ₹${m.price} each` : ""}
            </span>
          </div>
        ))}
      </div>
      {r.quote != null && (
        <p className="quote">
          Pharmacy quote: <strong>₹{r.quote.toFixed(2)}</strong> · INR ·{" "}
          {r.pharmacy.demo ? "sample price" : "confirm final price at pickup"}
        </p>
      )}
      <ol className="request-timeline">
        {r.events.map((e: any, i: number) => (
          <li key={i}>
            <span className="timeline-dot" />
            <div>
              <strong>{labels[e.status]}</strong>
              <small>{new Date(e.at).toLocaleString()}</small>
              {e.note && <p>{e.note}</p>}
            </div>
          </li>
        ))}
      </ol>
      {r.prescription_id && (
        <a
          className="secondary"
          href={`/api/platform/prescriptions/${r.prescription_id}/file`}
          target="_blank"
          rel="noreferrer"
        >
          View submitted prescription
        </a>
      )}
      {operator && r.status === "reviewing" && (
        <div className="review-box">
          <h3>Pharmacist review</h3>
          <p>
            Check the original prescription where required, product, strength,
            pack, legality and suitability. OCR is not a validated prescription.
            Classification is unknown in this demo catalog, so every request
            requires review.
          </p>
          <label className="check-label">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            I have completed pharmacist review
            {r.pharmacy.demo ? " for this fictional demo" : ""}.
          </label>
          <label>
            Review note
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              placeholder="Record the checks performed; do not add unnecessary patient details."
            />
          </label>
        </div>
      )}
      {error && (
        <div role="alert" className="notice error">
          {error}
        </div>
      )}
      <div className="request-actions">
        {(operator
          ? actions[r.status] || []
          : [
                "submitted",
                "reviewing",
                "confirmed",
                "preparing",
                "ready",
              ].includes(r.status)
            ? ["cancelled"]
            : []
        ).map((status) => (
          <button
            className={
              ["confirmed", "ready", "completed"].includes(status)
                ? "primary"
                : "secondary"
            }
            key={status}
            disabled={
              busy ||
              (status === "confirmed" && (!reviewed || note.trim().length < 5))
            }
            onClick={() => act(status)}
          >
            {status === "reviewing"
              ? "Start review"
              : status === "confirmed"
                ? "Confirm & reserve stock"
                : status === "cancelled"
                  ? "Cancel request"
                  : status === "rejected"
                    ? "Reject request"
                    : status === "unavailable"
                      ? "Mark unavailable"
                      : status === "preparing"
                        ? "Start preparing"
                        : status === "ready"
                          ? "Mark ready for pickup"
                          : "Complete request"}
          </button>
        ))}
      </div>
      <p className="small muted">
        Expires {new Date(r.expires_at).toLocaleString()}.{" "}
        {r.pharmacy.demo
          ? "Fictional pickup — do not visit a real shop for this request."
          : "Bring the original prescription if required; final dispensing is the pharmacy’s decision."}
      </p>
    </article>
  );
}
