import React, { useEffect, useRef, useState } from "react";

import {
  FileText,
  Search,
  ArrowUpRight,
  ArrowRight,
  Bookmark,
  Check,
  Plus,
  MapPin,
  ExternalLink,
  Pill,
  Leaf,
  BookOpen,
  Heart,
  RotateCcw,
  SlidersHorizontal,
  LoaderCircle,
  Trash2,
  Clock,
  MessageCircle,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import {
  PlatformProvider,
  usePlatform,
  AuthScreen,
  PartnersScreen,
  RequestsScreen,
  VoiceButton,
} from "./Platform";
import { ScannerScreen, PharmacyScreen, AdminScreen } from "./Workspaces";
import Pharmacies from "./Pharmacies.jsx";
import { api, readStore, signature } from "./lib.js";
const emptyState = { medicineId: null, intent: null };
function App() {
  const platform = usePlatform();
  const [screen, setScreen] = useState("home"),
    [status, setStatus] = useState(null),
    [query, setQuery] = useState(""),
    [response, setResponse] = useState(null),
    [context, setContext] = useState(emptyState),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [shelf, setShelf] = useState(() =>
    readStore("medifast.shelf.v2", []).filter(
      (x) =>
        typeof x.id === "string" &&
        typeof x.name === "string" &&
        typeof x.note === "string" &&
        typeof x.generic === "string" &&
        (x.strength == null || typeof x.strength === "string") &&
        (x.form == null || typeof x.form === "string"),
    ),
  );
  const [recent, setRecent] = useState(() =>
    readStore("medifast.recent.v2", []).filter(
      (x) => typeof x.query === "string" && typeof x.name === "string",
    ),
  );
  const [storageError, setStorageError] = useState(""),
    [toast, setToast] = useState(""),
    [followup, setFollowup] = useState(""),
    [explanation, setExplanation] = useState(null),
    [aiBusy, setAiBusy] = useState(false);
  const searchInput = useRef(),
    resultRef = useRef(),
    request = useRef(null),
    aiRequest = useRef(null),
    sequence = useRef(0);
  const medicine = response?.medicine;
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("medicine"),
      destination = params.get("screen");
    if (id && /^[-a-z0-9]{1,64}$/.test(id)) {
      send("", id, emptyState).then((data) => {
        if (data?.status === "confirmed" && destination === "partners") {
          platform.setBasket([{ ...data.medicine, quantity: 1 }]);
          navigate("partners");
        }
      });
    } else if (["scanner", "partners"].includes(destination))
      setScreen(destination);
  }, []);
  useEffect(() => {
    api("/api/status")
      .then(setStatus)
      .catch((e) => setError(e.message));
    return () => {
      request.current?.abort();
      aiRequest.current?.abort();
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("medifast.shelf.v2", JSON.stringify(shelf));
      localStorage.setItem("medifast.recent.v2", JSON.stringify(recent));
    } catch {
      setStorageError(
        "Browser storage is unavailable or full. Your shelf will only last for this visit.",
      );
    }
  }, [shelf, recent]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 2800);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const shortcut = (e) => {
      if (
        e.key === "/" &&
        !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)
      ) {
        e.preventDefault();
        setScreen("home");
        setTimeout(() => searchInput.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  function reset() {
    sequence.current++;
    request.current?.abort();
    aiRequest.current?.abort();
    setResponse(null);
    setContext(emptyState);
    setQuery("");
    setError("");
    setLoading(false);
    setExplanation(null);
    setAiBusy(false);
    setFollowup("");
    setScreen("home");
    setTimeout(() => searchInput.current?.focus(), 0);
  }
  function navigate(next) {
    sequence.current++;
    request.current?.abort();
    aiRequest.current?.abort();
    setLoading(false);
    setAiBusy(false);
    setScreen(next);
    setError("");
  }
  async function send(text, confirmId = null, requestState = context) {
    const seq = ++sequence.current;
    request.current?.abort();
    aiRequest.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    setExplanation(null);
    setAiBusy(false);
    setScreen("home");
    try {
      const data = await api("/api/message", {
        method: "POST",
        body: JSON.stringify({ query: text, state: requestState, confirmId }),
        signal: controller.signal,
      });
      if (seq !== sequence.current) return;
      setResponse(data);
      setContext(data.state);
      setFollowup("");
      if (data.status === "confirmed") {
        const m = data.medicine;
        setRecent((items) =>
          [
            {
              query: `${m.name} ${m.strength || ""} ${m.form || ""}`,
              name: m.name,
            },
            ...items.filter((x) => x.name !== m.name),
          ].slice(0, 6),
        );
        if (data.state.intent === "pharmacies") setScreen("pharmacies");
      }
      setTimeout(() => {
        resultRef.current?.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "instant"
            : "smooth",
          block: "start",
        });
        resultRef.current?.focus({ preventScroll: true });
      }, 60);
      return data;
    } catch (e) {
      if (e.name !== "AbortError" && seq === sequence.current)
        setError(
          e.name === "TimeoutError"
            ? "The request took too long. Please try again."
            : e.message,
        );
    } finally {
      if (seq === sequence.current) setLoading(false);
    }
  }
  function save(m) {
    if (shelf.some((x) => x.id === m.id)) {
      setShelf((items) => items.filter((x) => x.id !== m.id));
      setToast("Removed from your shelf");
    } else {
      if (shelf.length >= 100) {
        setToast("Your shelf holds 100 medicines. Remove one to make room.");
        return;
      }
      setShelf((items) => [
        ...items,
        {
          id: m.id,
          name: m.name,
          generic: m.generic,
          strength: m.strength,
          form: m.form,
          note: "",
        },
      ]);
      setToast("A little less to remember. Saved to your shelf.");
    }
  }
  async function explain() {
    aiRequest.current?.abort();
    const controller = new AbortController();
    aiRequest.current = controller;
    setAiBusy(true);
    try {
      const data = await api(`/api/medicines/${medicine.id}/explain`, {
        method: "POST",
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setExplanation(data);
    } catch (e) {
      if (e.name !== "AbortError")
        setExplanation({
          kind: "catalog",
          text:
            medicine.simple ||
            medicine.description ||
            "An explanation is not supplied.",
          reason: "unavailable",
        });
    } finally {
      if (!controller.signal.aborted) setAiBusy(false);
    }
  }
  const saved = medicine && shelf.some((x) => x.id === medicine.id);
  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="header">
        <button className="brand" onClick={reset} aria-label="MediFast home">
          <span className="brand-mark">
            <Plus strokeWidth={3} />
          </span>
          MediFast<span className="brand-dot">●</span>
        </button>
        <nav aria-label="Main navigation">
          {platform.user?.role === "pharmacy" && (
            <button
              className={`nav-role ${screen === "operator" ? "nav-active" : ""}`}
              aria-current={screen === "operator" ? "page" : undefined}
              onClick={() => navigate("operator")}
            >
              Pharmacy desk
            </button>
          )}
          {platform.user?.role === "admin" && (
            <button
              className={`nav-role ${screen === "admin" ? "nav-active" : ""}`}
              aria-current={screen === "admin" ? "page" : undefined}
              onClick={() => navigate("admin")}
            >
              Admin
            </button>
          )}
          <button
            className={screen === "home" ? "nav-active" : ""}
            aria-current={screen === "home" ? "page" : undefined}
            onClick={() => navigate("home")}
          >
            Explore
          </button>
          <button
            className={screen === "pharmacies" ? "nav-active" : ""}
            aria-current={screen === "pharmacies" ? "page" : undefined}
            onClick={() => navigate("pharmacies")}
          >
            <MapPin size={16} />
            Nearby
          </button>
          <button
            className={screen === "partners" ? "nav-active" : ""}
            aria-current={screen === "partners" ? "page" : undefined}
            onClick={() => navigate("partners")}
          >
            Find my pack
          </button>
          <button
            className={screen === "scanner" ? "nav-active" : ""}
            aria-current={screen === "scanner" ? "page" : undefined}
            onClick={() => navigate("scanner")}
          >
            Scan
          </button>
          <button
            className={screen === "requests" ? "nav-active" : ""}
            aria-current={screen === "requests" ? "page" : undefined}
            onClick={() => navigate("requests")}
          >
            My requests
          </button>
          <button
            className={screen === "account" ? "nav-active" : ""}
            aria-current={screen === "account" ? "page" : undefined}
            onClick={() => navigate("account")}
          >
            {platform.user ? "Account" : "Sign in"}
          </button>
          <button
            className={screen === "shelf" ? "nav-active" : ""}
            aria-current={screen === "shelf" ? "page" : undefined}
            onClick={() => navigate("shelf")}
          >
            <Bookmark size={16} />
            My shelf <span className="count">{shelf.length}</span>
          </button>
        </nav>
        <span className="mode-indicator">
          <i />
          {status?.catalog.mode === "catalog" ? "Your catalog" : "Demo edition"}
        </span>
      </header>
      <main id="main">
        {screen === "home" && (
          <>
            <section className={`hero ${response ? "hero-compact" : ""}`}>
              <div className="hero-copy">
                <h1>
                  Medicine confusion,
                  <br />
                  <em>sorted.</em>
                </h1>
                <p className="hero-description">
                  That name on the prescription? Let’s clear it up.
                  <br className="desktop-break" /> Understand it, save it, find
                  a pharmacy to call.
                </p>
                <form
                  className="search-box"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (query.trim()) send(query);
                  }}
                >
                  <Search size={23} />
                  <label className="sr-only" htmlFor="medicine-search">
                    Search a medicine
                  </label>
                  <input
                    id="medicine-search"
                    ref={searchInput}
                    value={query}
                    maxLength={120}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="A medicine name, e.g. Dolo 650"
                    autoComplete="off"
                  />
                  <kbd>/</kbd>
                  <button
                    type="submit"
                    aria-label="Search medicine"
                    disabled={!query.trim()}
                  >
                    {loading ? (
                      <LoaderCircle className="spin" size={21} />
                    ) : (
                      <ArrowRight size={22} />
                    )}
                  </button>
                </form>
                <div className="search-extras">
                  <VoiceButton onText={setQuery} />
                  <button
                    className="text-button"
                    onClick={() => navigate("scanner")}
                  >
                    <FileText size={16} />
                    Scan a prescription
                  </button>
                </div>
                <div className="examples">
                  <span>Try a little clarity</span>
                  {["Dolo 650", "Cetirizine", "Paracetmol"].map((q) => (
                    <button
                      key={q}
                      onClick={() => {
                        setQuery(q);
                        send(q);
                      }}
                    >
                      {q}
                      <ArrowUpRight size={13} />
                    </button>
                  ))}
                </div>
                <p className="source-hint">
                  <ShieldCheck size={14} />
                  {status?.catalog.mode === "catalog"
                    ? "Your sourced catalog"
                    : "Small, sourced demo catalog"}{" "}
                  · No account needed
                </p>
              </div>
              {!response && (
                <div className="hero-guide" aria-label="How MediFast helps">
                  <div className="guide-head">
                    <span className="guide-mark">
                      <Plus size={19} strokeWidth={3} />
                    </span>
                    <span>MediFast in action</span>
                  </div>
                  <div className="guide-step">
                    <span className="guide-index">1</span>
                    <div>
                      <strong>Find the exact medicine</strong>
                      <small>Check the name, strength and form.</small>
                    </div>
                    <Search size={19} />
                  </div>
                  <div className="guide-step">
                    <span className="guide-index">2</span>
                    <div>
                      <strong>See shops nearby</strong>
                      <small>Location and contact details, with sources.</small>
                    </div>
                    <MapPin size={19} />
                  </div>
                  <div className="guide-step">
                    <span className="guide-index">3</span>
                    <div>
                      <strong>Ask before you go</strong>
                      <small>
                        A shop confirms availability; proximity doesn’t.
                      </small>
                    </div>
                    <MessageCircle size={19} />
                  </div>
                  <div className="guide-foot">
                    From a confusing name to a clear next step.{" "}
                    <ArrowUpRight size={17} />
                  </div>
                </div>
              )}
            </section>
            {error && (
              <div className="notice error" role="alert">
                {error}
                <button onClick={() => send(query)}>Try again</button>
              </div>
            )}
            {response ? (
              <section
                ref={resultRef}
                tabIndex={-1}
                className="results"
                aria-label="Search results"
              >
                <div className="section-top">
                  <span className="eyebrow">
                    {response.status === "confirmed"
                      ? "A NAME, MADE CLEAR"
                      : "LET’S CLEAR THAT UP"}
                  </span>
                  <button className="text-button" onClick={reset}>
                    <RotateCcw size={14} />
                    New search
                  </button>
                </div>
                {response.status === "candidates" && (
                  <div className="candidates">
                    <div className="section-intro">
                      <span className="icon-tile">
                        <SlidersHorizontal />
                      </span>
                      <div>
                        <h2>Which one is on your pack?</h2>
                        <p>{response.answer}</p>
                      </div>
                    </div>
                    <div className="candidate-grid">
                      {response.candidates.map((m) => (
                        <button
                          className="candidate"
                          key={m.id}
                          onClick={() => send("", m.id)}
                        >
                          <span className="medicine-symbol">
                            <Pill />
                          </span>
                          <span>
                            <strong>{m.name}</strong>
                            <small>{signature(m)}</small>
                            <span>{m.generic}</span>
                          </span>
                          <ArrowRight size={20} />
                        </button>
                      ))}
                    </div>
                    <p className="muted small">
                      Similar names or shared ingredients don’t mean
                      interchangeable medicines.
                    </p>
                    <button className="text-button" onClick={reset}>
                      None of these? Try the full package name{" "}
                      <ArrowRight size={14} />
                    </button>
                  </div>
                )}
                {medicine ? (
                  <div className="detail-grid">
                    <article className="medicine-card">
                      <button
                        className="primary request-medicine"
                        onClick={() => {
                          platform.setBasket(
                            [
                              ...platform.basket.filter(
                                (x) => x.id !== medicine.id,
                              ),
                              { ...medicine, quantity: 1 },
                            ].slice(0, 8),
                          );
                          navigate("partners");
                        }}
                      >
                        Request this exact medicine <ArrowRight size={17} />
                      </button>
                      <div className="medicine-card-top">
                        <span className="tag">
                          <Check size={13} />
                          Matched catalog record
                        </span>
                        <span className="muted small">
                          {medicine.demo ? "DEMO RECORD" : "CATALOG FACTS"}
                        </span>
                      </div>
                      <div className="medicine-heading">
                        <span className="medicine-symbol large">
                          <Pill size={32} />
                        </span>
                        <div>
                          <h2>{medicine.name}</h2>
                          <p>{signature(medicine)}</p>
                        </div>
                        <button
                          className={`bookmark-button ${saved ? "is-saved" : ""}`}
                          aria-label={
                            saved ? "Remove from shelf" : "Save to shelf"
                          }
                          aria-pressed={!!saved}
                          onClick={() => save(medicine)}
                        >
                          {saved ? <Check /> : <Bookmark />}
                        </button>
                      </div>
                      <div className="ingredient">
                        <span>
                          ACTIVE INGREDIENT
                          {medicine.generic.includes("+") ? "S" : ""}
                        </span>
                        <strong>{medicine.generic}</strong>
                      </div>
                      <p className="description">
                        {medicine.description ||
                          "This record does not include a description yet. Explore the linked source or ask a pharmacist."}
                      </p>
                      <div className="disclosures">
                        <details>
                          <summary>
                            Precautions to know <Plus size={17} />
                          </summary>
                          {medicine.precautions.length ? (
                            <ul>
                              {medicine.precautions.map((x) => (
                                <li key={x}>{x}</li>
                              ))}
                            </ul>
                          ) : (
                            <p>Precautions are not supplied in this record.</p>
                          )}
                        </details>
                        <details>
                          <summary>
                            Possible side effects <Plus size={17} />
                          </summary>
                          {medicine.sideEffects.length ? (
                            <>
                              <ul>
                                {medicine.sideEffects.map((x) => (
                                  <li key={x}>{x}</li>
                                ))}
                              </ul>
                              <p className="small muted">
                                A short summary, not a complete list. Check the
                                package leaflet.
                              </p>
                            </>
                          ) : (
                            <p>Side effects are not supplied in this record.</p>
                          )}
                        </details>
                        <details>
                          <summary>
                            Where this information comes from <Plus size={17} />
                          </summary>
                          <p className="small">
                            {medicine.demo
                              ? "An illustrative catalog record with linked ingredient references. Confirm the exact product against its pack."
                              : "Imported catalog information. Check the source for its scope and review status."}
                          </p>
                          {medicine.sources.map((s) => (
                            <a
                              className="source-link"
                              key={s.url}
                              href={s.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {s.label}
                              <ExternalLink size={13} />
                            </a>
                          ))}
                          <p className="small muted">
                            Source review date:{" "}
                            {medicine.reviewedAt || "not supplied"}.{" "}
                            {medicine.demo &&
                              "Demo assembled 18 October 2026; this is not a clinical review date."}
                          </p>
                        </details>
                      </div>
                      <div className="medicine-actions">
                        <button
                          className="primary"
                          onClick={() => navigate("pharmacies")}
                        >
                          <MapPin size={18} />
                          Find nearby pharmacies
                          <ArrowUpRight size={18} />
                        </button>
                        <button
                          className={`secondary ${saved ? "saved-pop" : ""}`}
                          onClick={() => save(medicine)}
                        >
                          {saved ? <Check size={17} /> : <Bookmark size={17} />}{" "}
                          {saved ? "On your shelf" : "Save for later"}
                        </button>
                      </div>
                    </article>
                    <aside className="followup-card">
                      <span className="eyebrow">A LITTLE MORE CLARITY</span>
                      <h3>What else is on your mind?</h3>
                      <div className="context-label">
                        <span className="context-dot" />
                        About {medicine.name} ·{" "}
                        {medicine.strength || "strength unknown"}
                      </div>
                      <div className="followup-chips">
                        {[
                          ["Explain simply", "Explain simply"],
                          ["Side effects", "Side effects"],
                          ["What’s the generic?", "generic"],
                          ["Find pharmacies", "find pharmacies"],
                        ].map(([label, q]) => (
                          <button key={q} onClick={() => send(q)}>
                            {label}
                            <ArrowUpRight size={13} />
                          </button>
                        ))}
                      </div>
                      <div className="answer" aria-live="polite">
                        <MessageCircle size={17} />
                        <p>{response.answer}</p>
                      </div>
                      {response.state.intent === "simple" && (
                        <>
                          <button
                            className="text-button"
                            onClick={explain}
                            disabled={aiBusy}
                          >
                            <Sparkles size={15} />
                            {aiBusy
                              ? "Selecting evidence…"
                              : "Try an AI-assisted explanation"}
                          </button>
                          <p className="small muted">
                            Optional AI selects supplied sentences. Your catalog
                            card is already complete.
                          </p>
                        </>
                      )}
                      {explanation && (
                        <div className="explanation">
                          <span className="eyebrow">
                            {explanation.kind === "ai_selection"
                              ? "AI-SELECTED CATALOG EVIDENCE"
                              : "CATALOG EXPLANATION"}
                          </span>
                          <p>{explanation.text}</p>
                          {!explanation.available && (
                            <small>
                              AI{" "}
                              {explanation.reason === "not_configured"
                                ? "is off"
                                : "is unavailable"}
                              ; showing the supplied evidence.
                            </small>
                          )}
                        </div>
                      )}
                      <form
                        className="followup-input"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (followup.trim()) send(followup);
                        }}
                      >
                        <label className="sr-only" htmlFor="followup">
                          Ask a follow-up
                        </label>
                        <input
                          id="followup"
                          value={followup}
                          maxLength={200}
                          onChange={(e) => setFollowup(e.target.value)}
                          placeholder="Or ask in your own words…"
                        />
                        <button
                          aria-label="Send follow-up"
                          disabled={!followup.trim() || loading}
                        >
                          <ArrowRight size={18} />
                        </button>
                      </form>
                      <p className="small muted">
                        You can also type a different medicine name to switch.
                      </p>
                    </aside>
                  </div>
                ) : (
                  response.status !== "candidates" && (
                    <div className="empty-state">
                      <span className="icon-tile">
                        <Search />
                      </span>
                      <h2>
                        {response.status === "not_found"
                          ? "Not in this little catalog. Yet."
                          : response.status === "boundary"
                            ? "Let’s keep this informational."
                            : "Which medicine do you mean?"}
                      </h2>
                      <p>{response.answer}</p>
                      <button className="secondary" onClick={reset}>
                        Try another name <ArrowRight size={16} />
                      </button>
                    </div>
                  )
                )}
              </section>
            ) : (
              <>
                {recent.length > 0 && (
                  <section className="recents">
                    <div className="section-top">
                      <h2>
                        <Clock size={17} />
                        Recently explored
                      </h2>
                      <button
                        className="text-button"
                        onClick={() => setRecent([])}
                      >
                        Clear history
                      </button>
                    </div>
                    <div>
                      {recent.map((x) => (
                        <button
                          key={x.name}
                          onClick={() => {
                            setQuery(x.query);
                            send(x.query);
                          }}
                        >
                          {x.name}
                          <ArrowUpRight size={14} />
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                <section className="feature-pair" aria-label="Explore MediFast">
                  <button
                    className="feature-tile finder-tile"
                    onClick={() => navigate("pharmacies")}
                  >
                    <h2>
                      Less running around.
                      <br />
                      More calling ahead.
                    </h2>
                    <p>
                      Nearby pharmacies, sourced phone numbers, and
                      exact-product reports from local shop uploads.
                    </p>
                    <span className="feature-link">
                      Explore nearby <ArrowUpRight size={22} />
                    </span>
                    <MapPin
                      className="feature-art"
                      size={100}
                      strokeWidth={1}
                    />
                  </button>
                  <button
                    className="feature-tile shop-tile"
                    onClick={() => navigate("operator")}
                  >
                    <h2>
                      A spreadsheet today.
                      <br />A shopfront in minutes.
                    </h2>
                    <p>
                      Bring a Marg-style stock export. Preview it, match it, and
                      list it in this local experiment.
                    </p>
                    <span className="feature-link">
                      Open pharmacy desk <ArrowUpRight size={22} />
                    </span>
                  </button>
                </section>
                <section className="how-section">
                  <div className="section-top">
                    <h2>From “what is this?” to “got it.”</h2>
                    <span className="muted small">
                      One name. A clearer next step.
                    </span>
                  </div>
                  <div className="how-grid">
                    {[
                      [
                        Search,
                        "Find your medicine",
                        "Brand, ingredient or a slightly wonky spelling. Start with what’s on the pack.",
                      ],
                      [
                        BookOpen,
                        "Get the important bits",
                        "Plain-language facts, useful precautions, and sources you can explore.",
                      ],
                      [
                        MapPin,
                        "Take the next step",
                        "Save a reference or find a pharmacy. Give them a call before heading out.",
                      ],
                    ].map(([Icon, title, copy]) => (
                      <article key={title}>
                        <div className="how-top">
                          <Icon size={22} />
                        </div>
                        <h3>{title}</h3>
                        <p>{copy}</p>
                      </article>
                    ))}
                  </div>
                </section>
                <div className="shelf-banner">
                  <span className="banner-icon">
                    <Bookmark size={30} />
                  </span>
                  <div>
                    <h3>A little shelf. A little less to remember.</h3>
                    <p>
                      Keep medicine names and your own notes together, right
                      here.
                    </p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => navigate("shelf")}
                  >
                    Meet your shelf <ArrowRight size={18} />
                  </button>
                </div>
              </>
            )}
          </>
        )}
        {screen === "shelf" && (
          <section className="shelf-screen">
            <p className="eyebrow">YOUR OWN LITTLE REFERENCE LIBRARY</p>
            <div className="page-title">
              <div>
                <h1>
                  My medicine <em>shelf.</em>
                </h1>
                <p>Names worth keeping. Notes in your own words.</p>
              </div>
              <span className="shelf-count">
                <Bookmark />
                {shelf.length} saved
              </span>
            </div>
            <div className="notice">
              <BookOpen size={18} />A reference shelf, not a medication
              schedule. Saved only in this browser.
            </div>
            {!shelf.length ? (
              <div className="empty-shelf">
                <div className="shelf-illustration">
                  <BookOpen size={64} strokeWidth={1} />
                  <span />
                </div>
                <h2>Make a little room for clarity.</h2>
                <p>
                  Find a medicine and tap its bookmark.
                  <br />
                  Your future self will thank you.
                </p>
                <button className="primary" onClick={reset}>
                  Find your first medicine <ArrowRight size={17} />
                </button>
              </div>
            ) : (
              <div className="shelf-grid">
                {shelf.map((m) => (
                  <article className="shelf-card" key={m.id}>
                    <div className="section-top">
                      <span className="medicine-symbol">
                        <Pill />
                      </span>
                      <button
                        className="icon-button"
                        aria-label={`Remove ${m.name}`}
                        onClick={() => {
                          setShelf((items) =>
                            items.filter((x) => x.id !== m.id),
                          );
                          setToast("Removed from your shelf");
                        }}
                      >
                        <Trash2 size={17} />
                      </button>
                    </div>
                    <h2>{m.name}</h2>
                    <p className="muted">{signature(m)}</p>
                    <p>{m.generic}</p>
                    <label htmlFor={`note-${m.id}`}>
                      A note to yourself <span>{m.note.length}/500</span>
                    </label>
                    <textarea
                      id={`note-${m.id}`}
                      maxLength={500}
                      rows={3}
                      value={m.note}
                      placeholder="e.g. Bring the package to my next appointment"
                      onChange={(e) =>
                        setShelf((items) =>
                          items.map((x) =>
                            x.id === m.id ? { ...x, note: e.target.value } : x,
                          ),
                        )
                      }
                    />
                    <span className="small muted">
                      {storageError
                        ? "Notes kept for this visit"
                        : "Notes save automatically"}
                    </span>
                    <button
                      className="text-button"
                      onClick={() =>
                        send("", m.id, { medicineId: null, intent: "details" })
                      }
                    >
                      Revisit medicine <ArrowRight size={17} />
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}
        {screen === "account" && <AuthScreen navigate={navigate} />}
        {screen === "partners" && <PartnersScreen navigate={navigate} />}
        {screen === "requests" && <RequestsScreen navigate={navigate} />}
        {screen === "scanner" && <ScannerScreen navigate={navigate} />}
        {screen === "operator" && <PharmacyScreen navigate={navigate} />}
        {screen === "admin" && <AdminScreen navigate={navigate} />}
        {screen === "pharmacies" && (
          <Pharmacies
            medicine={medicine}
            mode={status?.pharmacies || "live"}
            back={() => navigate("home")}
          />
        )}
        {storageError && (
          <div className="notice error" role="alert">
            {storageError}
          </div>
        )}
        <footer>
          <div>
            <span className="footer-mark">
              <Plus size={16} />
            </span>
            <span>A little clarity, a little care.</span>
          </div>
          <p>
            For understanding, not prescribing. A pharmacist can help with
            what’s right for you.
          </p>
          <span className="footer-local">
            <Leaf size={14} />
            Made to feel simple.
          </span>
        </footer>
      </main>
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          {toast}
        </div>
      )}
    </div>
  );
}
export default function MediFast() {
  return (
    <PlatformProvider>
      <App />
    </PlatformProvider>
  );
}
