import React, { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  FileText,
  ScanLine,
  Store,
  Upload,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  platformApi,
  usePlatform,
  SignInGate,
  RequestsScreen,
  Medicine,
} from "./Platform";
async function lookup(query: string) {
  const r = await fetch("/api/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, state: { medicineId: null, intent: null } }),
  });
  if (!r.ok) throw Error("Medicine lookup failed.");
  return r.json();
}
function MedicinePicker({ onPick }: { onPick: (m: Medicine) => void }) {
  const [query, setQuery] = useState(""),
    [choices, setChoices] = useState<Medicine[]>([]),
    [message, setMessage] = useState("");
  async function search(e: any) {
    e.preventDefault();
    try {
      const d = await lookup(query);
      setChoices(d.medicine ? [d.medicine] : d.candidates);
      setMessage(
        d.status === "not_found"
          ? "No catalog match. Check the exact pack name."
          : "Choose the exact product below.",
      );
    } catch (e: any) {
      setMessage(e.message);
    }
  }
  return (
    <div className="medicine-picker">
      <form onSubmit={search}>
        <label>
          Medicine to list
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Dolo 650"
            maxLength={120}
          />
        </label>
        <button className="secondary">Look up</button>
      </form>
      <p className="small">{message}</p>
      {choices.map((m) => (
        <button
          className="candidate-pill"
          key={m.id}
          onClick={() => {
            onPick(m);
            setChoices([]);
            setMessage(`${m.name} ${m.strength} ${m.form} selected.`);
          }}
        >
          {m.name} · {m.strength} · {m.form}
          <Check size={15} />
        </button>
      ))}
    </div>
  );
}
export function ScannerScreen({ navigate }: { navigate: (s: string) => void }) {
  const p = usePlatform(),
    [file, setFile] = useState<File | null>(null),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState<any>(null),
    [text, setText] = useState(""),
    [rows, setRows] = useState<any[]>([]),
    [selected, setSelected] = useState<Medicine[]>([]),
    [uploads, setUploads] = useState<any[]>([]),
    [reported, setReported] = useState(false);
  async function reload() {
    if (p.user) setUploads((await platformApi("/prescriptions")).items);
  }
  useEffect(() => {
    reload().catch((e) => setError(e.message));
  }, [p.user?.id]);
  if (!p.user) return <SignInGate navigate={navigate} />;
  if (p.user.role !== "customer")
    return (
      <div className="empty-state">
        <h2>Prescription scanning belongs to the customer workspace.</h2>
        <p>
          Pharmacy operators see uploads only when attached to their own
          incoming requests.
        </p>
      </div>
    );
  async function scan() {
    if (!file) return;
    setBusy(true);
    setError("");
    setSelected([]);
    setRows([]);
    setResult(null);
    setReported(false);
    try {
      const form = new FormData();
      form.append("file", file);
      const d = await platformApi("/prescriptions", {
        method: "POST",
        body: form,
      });
      setResult(d);
      setText(d.text);
      await reload();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function resolve() {
    setBusy(true);
    setError("");
    setSelected([]);
    try {
      const lines = text
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 12);
      const results = [];
      for (const line of lines) {
        const d = await lookup(line.replace(/^\d+[.)]\s*/, ""));
        results.push({
          line,
          choices: d.medicine ? [d.medicine] : d.candidates,
          status: d.status,
        });
      }
      setRows(results);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function select(m: Medicine) {
    if (selected.some((x) => x.id === m.id)) return;
    setSelected([...selected, { ...m, quantity: 1 }].slice(0, 8));
  }
  return (
    <section className="platform-screen scanner-screen">
      <p className="eyebrow">PRESCRIPTION → CONFIRMED LIST → PHARMACY</p>
      <h1>
        Less retyping.
        <br />
        <em>More double-checking.</em>
      </h1>
      <p>
        Local OCR reads printed text from your image. Handwriting can be
        unreliable. You confirm every medicine; a pharmacist reviews the
        request.
      </p>
      {p.mode === "demo" && (
        <p className="small muted">
          Use synthetic documents in demo mode. Requests sent to the shared demo
          pharmacy are visible to anyone with its login.
        </p>
      )}
      {p.user?.id === "demo-customer" && (
        <p className="notice">
          This shared demo account accepts only the fictional sample below.
          Everyone with the demo login can see its uploads. Create your own
          account for other documents.
        </p>
      )}
      <div className="scanner-grid">
        <div className="scan-upload">
          <ScanLine size={42} />
          <h2>Bring your prescription</h2>
          <p>
            PNG, JPEG, WebP or PDF · up to 5 MB.
            <br />
            PDFs: first three pages. Images: up to 16 megapixels.
          </p>
          <label className="secondary upload-label">
            Choose image or PDF
            <input
              aria-label="Prescription file"
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf"
              onChange={(e) => {
                setFile(e.target.files?.[0] || null);
                setResult(null);
                setRows([]);
                setSelected([]);
              }}
            />
          </label>
          <span className="small">{file?.name || "No file selected"}</span>
          <button
            className="text-button"
            onClick={async () => {
              const r = await fetch("/demo-prescription.png");
              setFile(
                new File([await r.blob()], "demo-prescription.png", {
                  type: "image/png",
                }),
              );
              setResult(null);
              setSelected([]);
              setRows([]);
            }}
          >
            Use clearly fictional demo image
          </button>
          <label className="check-label">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            I agree to local processing and storage for up to 7 days. Only a
            pharmacy I send a request to can view it.
          </label>
          <button
            className="primary"
            disabled={!file || !consent || busy}
            onClick={scan}
          >
            {busy ? "Processing locally…" : "Scan prescription"}
            <ArrowRight size={17} />
          </button>
        </div>
        <div className="desk-panel">
          <h2>Review the extracted text</h2>
          {result && (
            <p className="notice">
              {result.notice} OCR engine confidence: {result.confidence}/100 —
              this is not confidence in medicine identity.
            </p>
          )}
          {result?.unreadable && (
            <p>
              No readable text found. Try a clearer photo or type the medicine
              names.
            </p>
          )}
          <label>
            Editable medicine lines
            <textarea
              className="scan-text"
              rows={10}
              value={text}
              maxLength={10000}
              placeholder={"Dolo 650 mg tablet\nCetirizine 10 mg tablet"}
              onChange={(e) => {
                setText(e.target.value);
                setRows([]);
                setSelected([]);
              }}
            />
          </label>
          <p className="small muted">
            Keep one medicine per line. Remove names, addresses, instructions
            and unrelated text. Up to 12 lines / 8 confirmed products.
          </p>
          <button
            className="secondary"
            disabled={!text.trim() || busy}
            onClick={resolve}
          >
            Find medicine candidates
          </button>
          {result && !reported && (
            <button
              className="text-button"
              onClick={async () => {
                await platformApi("/reports", {
                  method: "POST",
                  body: JSON.stringify({
                    kind: "ocr_error",
                    entity: result.id,
                    note: "Customer reported incorrect OCR extraction; no prescription text included.",
                  }),
                });
                setReported(true);
              }}
            >
              Report an extraction error
            </button>
          )}
          {reported && (
            <p role="status">
              Error report recorded without prescription text.
            </p>
          )}
        </div>
      </div>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {rows.length > 0 && (
        <section className="desk-panel">
          <h2>Confirm what is actually on the pack</h2>
          {rows.map((r, i) => (
            <div className="scan-candidate" key={i}>
              <strong>{r.line}</strong>
              {r.choices.length ? (
                r.choices.map((m: Medicine) => (
                  <button
                    className={`candidate-pill ${selected.some((x) => x.id === m.id) ? "chosen" : ""}`}
                    key={m.id}
                    onClick={() => select(m)}
                  >
                    {m.name} · {m.strength || "Strength unknown"} ·{" "}
                    {m.form || "Form unknown"} <Check size={16} />
                  </button>
                ))
              ) : (
                <p className="small muted">
                  No safe match. Correct the line above and look up again.
                </p>
              )}
            </div>
          ))}
          <div className="selected-list">
            <h3>{selected.length} explicitly confirmed</h3>
            {selected.map((m) => (
              <button
                className="candidate-pill"
                key={m.id}
                onClick={() =>
                  setSelected(selected.filter((x) => x.id !== m.id))
                }
              >
                {m.name} {m.strength} · remove ×
              </button>
            ))}
          </div>
          <button
            className="primary"
            disabled={!selected.length}
            onClick={() => {
              p.setBasket(selected);
              p.setPrescriptionId(result?.id || null);
              navigate("partners");
            }}
          >
            Find these medicines <ArrowRight size={17} />
          </button>
        </section>
      )}
      <section className="desk-panel">
        <h2>Your stored uploads</h2>
        <p className="small muted">
          Deleted after seven days. You can remove them sooner. Deletion also
          removes access from existing requests.
        </p>
        {uploads.length ? (
          uploads.map((x) => (
            <div className="upload-row" key={x.id}>
              <a
                href={`/api/platform/prescriptions/${x.id}/file`}
                target="_blank"
                rel="noreferrer"
              >
                <FileText size={16} />
                Upload · {new Date(x.created_at).toLocaleString()}
              </a>
              <button
                className="text-button"
                onClick={async () => {
                  try {
                    await platformApi("/prescriptions/" + x.id, {
                      method: "DELETE",
                    });
                    if (p.prescriptionId === x.id) p.setPrescriptionId(null);
                    if (result?.id === x.id) setResult(null);
                    await reload();
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
              >
                <Trash2 size={16} />
                Delete upload
              </button>
            </div>
          ))
        ) : (
          <p>No uploads stored.</p>
        )}
      </section>
    </section>
  );
}
export function PharmacyScreen({
  navigate,
}: {
  navigate: (s: string) => void;
}) {
  const p = usePlatform(),
    [tab, setTab] = useState("inbox"),
    [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<Medicine | null>(null),
    [stockRevision, setStockRevision] = useState<number | null>(null),
    [quantity, setQuantity] = useState(0),
    [price, setPrice] = useState(0),
    [unit, setUnit] = useState("one sealed retail pack"),
    [notice, setNotice] = useState("");
  const [profile, setProfile] = useState<any>({
    name: "",
    address: "",
    phone: "",
    hours: "",
    license: "",
    pharmacistName: "",
    pharmacistReg: "",
    lat: 26.9124,
    lng: 75.7873,
  });
  async function reload() {
    const d = await platformApi("/my-pharmacy");
    setData(d);
    if (d.pharmacy)
      setProfile((current: any) =>
        current.id === d.pharmacy.id ? current : d.pharmacy,
      );
  }
  useEffect(() => {
    if (p.user?.role === "pharmacy") reload().catch((e) => setError(e.message));
  }, [p.user?.id, p.version]);
  if (!p.user) return <SignInGate navigate={navigate} />;
  if (p.user.role !== "pharmacy")
    return (
      <div className="empty-state">
        <h2>Pharmacy operator access required.</h2>
      </div>
    );
  async function saveStock(e: any) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await platformApi("/my-pharmacy/inventory", {
        method: "PUT",
        body: JSON.stringify({
          medicineId: selected?.id,
          quantity,
          price,
          unit,
          revision: stockRevision,
        }),
      });
      await reload();
      setSelected(null);
      setNotice(
        "Inventory updated. Consumer search now uses this stock report.",
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="workspace-tabs">
        {[
          ["inbox", "Incoming requests"],
          ["stock", "Inventory"],
          ["profile", "Business & verification"],
        ].map(([key, label]) => (
          <button
            className={tab === key ? "selected" : ""}
            aria-pressed={tab === key}
            key={key}
            onClick={() => {
              setTab(key);
              setNotice("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {error && (
        <div role="alert" className="notice error">
          {error}
        </div>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {tab === "inbox" && <RequestsScreen operator navigate={navigate} />}
      {tab === "stock" && (
        <section className="platform-screen">
          <p className="eyebrow">PARTNER-MANAGED INVENTORY</p>
          <h1>
            Your shelves,
            <br />
            <em>clearly reported.</em>
          </h1>
          <p>
            Report stock available for new requests, excluding already reserved
            packs. Reports become unknown after 24 hours until refreshed.
          </p>
          {!data?.pharmacy ? (
            <p>Register your business first.</p>
          ) : (
            <>
              <h2>Add or update one exact product</h2>
              <div className="desk-panel">
                <MedicinePicker
                  onPick={(m) => {
                    setSelected(m);
                    const old = data.inventory.find(
                      (x: any) => x.medicine_id === m.id,
                    );
                    setStockRevision(old?.revision ?? null);
                    setQuantity(old?.quantity || 0);
                    setPrice(old?.price || 0);
                    setUnit(old?.unit || "one sealed retail pack");
                  }}
                />
                {selected && (
                  <form onSubmit={saveStock}>
                    <h3>
                      {selected.name} · {selected.strength} · {selected.form}
                    </h3>
                    <div className="field-grid">
                      <label>
                        Available packs
                        <input
                          type="number"
                          min={0}
                          max={100000}
                          required
                          value={quantity}
                          onChange={(e) => setQuantity(Number(e.target.value))}
                        />
                      </label>
                      <label>
                        Price per listed unit (INR)
                        <input
                          type="number"
                          min={0}
                          max={100000}
                          step="0.01"
                          required
                          value={price}
                          onChange={(e) => setPrice(Number(e.target.value))}
                        />
                      </label>
                      <label>
                        Pack / unit description
                        <input
                          required
                          maxLength={100}
                          value={unit}
                          onChange={(e) => setUnit(e.target.value)}
                        />
                      </label>
                    </div>
                    <p className="small muted">
                      Report saleable packs after checking expiry. Exclude packs
                      already reserved for active requests.
                    </p>
                    <button className="primary" disabled={busy}>
                      Save stock report
                    </button>
                  </form>
                )}
              </div>
              <InventoryImport reload={reload} />
              <div className="inventory-list">
                {data.inventory.map((s: any) => (
                  <article className="desk-panel" key={s.medicine_id}>
                    <div className="section-top">
                      <h3>
                        {s.medicine?.name} {s.medicine?.strength} ·{" "}
                        {s.medicine?.form}
                      </h3>
                      <span className="tag">
                        {s.fresh ? "FRESH REPORT" : "STALE · UNKNOWN"}
                      </span>
                    </div>
                    <p>
                      {s.quantity} available · ₹{s.price} / {s.unit}
                    </p>
                    <small>
                      Updated {new Date(s.updated_at).toLocaleString()} ·
                      revision {s.revision}
                    </small>
                  </article>
                ))}
              </div>
            </>
          )}
        </section>
      )}
      {tab === "profile" && (
        <section className="platform-screen">
          <p className="eyebrow">BUSINESS & PHARMACIST VERIFICATION</p>
          <h1>
            A real person
            <br />
            <em>behind the counter.</em>
          </h1>
          <p>
            {data?.pharmacy?.approved
              ? "Approved in this environment. Editing your profile requires a new admin review."
              : "Approval pending or not yet submitted. Your shop cannot receive requests until approved."}
          </p>
          <form
            className="desk-panel"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await platformApi("/my-pharmacy", {
                  method: "POST",
                  body: JSON.stringify(profile),
                });
                await reload();
                setNotice("Submitted for admin review.");
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="field-grid">
              {[
                ["name", "Business name"],
                ["address", "Business address"],
                ["phone", "Public phone"],
                ["hours", "Published operating hours"],
                ["license", "Drug licence reference"],
                ["pharmacistName", "Responsible pharmacist name"],
                ["pharmacistReg", "Pharmacist registration reference"],
                ["lat", "Latitude"],
                ["lng", "Longitude"],
              ].map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    value={profile[key] ?? ""}
                    maxLength={220}
                    required={!["phone", "hours"].includes(key)}
                    onChange={(e) =>
                      setProfile({ ...profile, [key]: e.target.value })
                    }
                  />
                </label>
              ))}
            </div>
            <p className="small">
              Demo submissions are fictional. Live approval requires independent
              licence, identity and pharmacist-registration checks by an
              administrator; entering a reference alone is not verification.
            </p>
            <button className="primary" disabled={busy}>
              Submit for approval
            </button>
          </form>
        </section>
      )}
    </>
  );
}
function InventoryImport({ reload }: { reload: () => Promise<void> }) {
  const [text, setText] = useState(""),
    [preview, setPreview] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  return (
    <section className="desk-panel">
      <h2>Bring a Marg-style stock export</h2>
      <p>
        CSV with Item Name, Strength, Form, Closing Stock, Unit and MRP. Only
        exact catalog identities can become partner inventory. Unknown rows stay
        out.
      </p>
      <input
        aria-label="Inventory CSV"
        type="file"
        accept=".csv,.tsv"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) {
            if (f.size > 300000) {
              setError("File limit is 300 KB.");
              return;
            }
            setText(await f.text());
            setPreview(null);
          }
        }}
      />
      <a href="/sample-stock.csv" download className="text-button">
        Download template
      </a>
      <label>
        Stock CSV
        <textarea
          rows={5}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setPreview(null);
            setDone(false);
          }}
        />
      </label>
      <button
        disabled={busy || !text.trim()}
        className="secondary"
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            setPreview(
              await platformApi("/my-pharmacy/import/preview", {
                method: "POST",
                body: JSON.stringify({ text }),
              }),
            );
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Preview import
      </button>
      {preview && (
        <>
          <p>
            {preview.rows.length} exact products ready. {preview.skipped.length}{" "}
            rows skipped.
          </p>
          {preview.skipped.map((s: any, i: number) => (
            <p className="small" key={i}>
              Row {s.row}: {s.reason}
            </p>
          ))}
          <ul>
            {preview.rows.map((r: any) => (
              <li key={r.medicineId}>
                {r.name} · {r.quantity} {r.unit} · ₹{r.price}
              </li>
            ))}
          </ul>
          <button
            className="primary"
            disabled={busy || !preview.rows.length}
            onClick={async () => {
              setBusy(true);
              try {
                await platformApi("/my-pharmacy/import/commit", {
                  method: "POST",
                  body: JSON.stringify({ token: preview.token }),
                });
                setPreview(null);
                setDone(true);
                await reload();
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Apply reviewed stock updates
          </button>
        </>
      )}
      {done && <p role="status">Inventory import applied.</p>}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
export function AdminScreen({ navigate }: { navigate: (s: string) => void }) {
  const p = usePlatform(),
    [tab, setTab] = useState("partners"),
    [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [checked, setChecked] = useState<Record<string, boolean>>({});
  async function reload() {
    setData(await platformApi("/admin"));
  }
  useEffect(() => {
    if (p.user?.role === "admin") reload().catch((e) => setError(e.message));
  }, [p.user?.id, p.version]);
  if (!p.user) return <SignInGate navigate={navigate} />;
  if (p.user.role !== "admin")
    return (
      <div className="empty-state">
        <h2>Admin access required.</h2>
      </div>
    );
  async function act(path: string, body?: any, method = "POST") {
    setBusy(true);
    setError("");
    try {
      await platformApi(path, {
        method,
        body: body ? JSON.stringify(body) : undefined,
      });
      await reload();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="platform-screen">
      <p className="eyebrow">ADMINISTRATION · BACKEND AUTHORIZED</p>
      <h1>
        Keep the details
        <br />
        <em>accountable.</em>
      </h1>
      <p>
        Review partner identities and catalog sources. Operational counts below
        come from stored records; no public medical-query analytics.
      </p>
      <div className="workspace-tabs">
        {[
          "partners",
          "users",
          "catalog",
          "reports",
          "requests",
          "audit",
          "health",
        ].map((t) => (
          <button
            className={tab === t ? "selected" : ""}
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
            key={t}
          >
            {t}
          </button>
        ))}
        <button onClick={reload} aria-label="Refresh administration">
          <RefreshCw size={17} />
        </button>
      </div>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {tab === "partners" &&
        data?.partners.map((x: any) => (
          <article className="desk-panel" key={x.id}>
            <div className="section-top">
              <h2>{x.name}</h2>
              <span className="tag">
                {x.demo ? "DEMO · " : ""}
                {x.approved ? "APPROVED" : "PENDING REVIEW"}
              </span>
            </div>
            <p>{x.address}</p>
            <p>
              Licence: {x.license}
              <br />
              Pharmacist: {x.pharmacistName} · {x.pharmacistReg}
            </p>
            <label className="check-label">
              <input
                type="checkbox"
                checked={!!checked[x.id]}
                onChange={(e) =>
                  setChecked({ ...checked, [x.id]: e.target.checked })
                }
              />
              I reviewed business identity, drug licence and pharmacist
              registration{x.demo ? " (fictional demo)" : ""}.
            </label>
            <button
              className="primary"
              disabled={busy || !checked[x.id]}
              onClick={() =>
                act(
                  "/admin/partners/" + x.id,
                  { approved: true, checked: true },
                  "PATCH",
                )
              }
            >
              Approve partner
            </button>
            {x.approved && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  act("/admin/partners/" + x.id, { approved: false }, "PATCH")
                }
              >
                Suspend partner
              </button>
            )}
          </article>
        ))}
      {tab === "users" &&
        data?.users.map((u: any) => (
          <div className="admin-row" key={u.id}>
            <div>
              <strong>{u.name}</strong>
              <p>
                {u.email} · {u.role} · {u.disabled ? "disabled" : "active"}
              </p>
            </div>
            <button
              className="secondary"
              disabled={busy || u.id === p.user.id}
              onClick={() =>
                act("/admin/users/" + u.id, { disabled: !u.disabled }, "PATCH")
              }
            >
              {u.disabled ? "Restore access" : "Disable access"}
            </button>
          </div>
        ))}
      {tab === "catalog" &&
        data?.catalog.map((m: any) => (
          <article className="desk-panel" key={m.id}>
            <h2>
              {m.name} · {m.strength} · {m.form}
            </h2>
            <p>{m.generic}</p>
            {m.sources.map((s: any) => (
              <a
                className="text-button"
                key={s.url}
                href={s.url}
                target="_blank"
                rel="noreferrer"
              >
                {s.label}
              </a>
            ))}
            <p>
              Source review:{" "}
              {m.review
                ? new Date(m.review.at).toLocaleString()
                : "Not recorded"}
              . Clinical verification is not implied.
            </p>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => act("/admin/catalog/" + m.id + "/review")}
            >
              Record source review
            </button>
          </article>
        ))}
      {tab === "reports" && (
        <>
          {!data?.reports.length && (
            <p>No reported OCR errors or AI selections yet.</p>
          )}
          {data?.reports.map((r: any) => (
            <article className="desk-panel" key={r.id}>
              <h3>
                {r.kind} · {r.resolved ? "resolved" : "open"}
              </h3>
              <p>{r.note}</p>
              <small>
                {r.entity} · {r.at}
              </small>
              {!r.resolved && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => act("/admin/reports/" + r.id + "/resolve")}
                >
                  Mark reviewed
                </button>
              )}
            </article>
          ))}
        </>
      )}
      {tab === "requests" &&
        data?.requests.map((r: any) => (
          <article className="desk-panel" key={r.id}>
            <h3>
              {r.pharmacy.name} · {r.status}
            </h3>
            <p>
              {r.id} · {r.items.length} selected products · {r.events.length}{" "}
              status events
            </p>
            <p>
              {["rejected", "unavailable", "expired"].includes(r.status)
                ? "Closed without pickup — inspect the status history."
                : "Active or completed workflow."}
            </p>
            <ol>
              {r.events.map((e: any, i: number) => (
                <li key={i}>
                  {e.status} · {e.at} · actor {e.actor}
                </li>
              ))}
            </ol>
          </article>
        ))}
      {tab === "audit" && (
        <div className="stock-table-wrap">
          <table className="stock-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Actor / entity</th>
              </tr>
            </thead>
            <tbody>
              {data?.audit.map((a: any) => (
                <tr key={a.id}>
                  <td>{a.at}</td>
                  <td>{a.action}</td>
                  <td>
                    {a.actor}
                    <br />
                    {a.entity}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tab === "health" && data && (
        <div className="desk-panel">
          <h2>Local system health</h2>
          {Object.entries(data.health).map(([key, value]) => (
            <p key={key}>
              <strong>{key}:</strong> {String(value)}
            </p>
          ))}
          <p>
            {data.users.length} accounts · {data.partners.length} partner
            profiles · {data.requests.length} most recent requests loaded.
          </p>
          <p>
            External payment, delivery and messaging providers are disabled. No
            credentials or service availability are implied.
          </p>
        </div>
      )}
    </section>
  );
}
