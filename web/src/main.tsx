import { StrictMode, Suspense, lazy, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./styles.css";
import { api, loadTelegramSdk } from "./api.ts";
import Landing from "./pages/Landing.tsx";

const Studio = lazy(() => import("./pages/Studio.tsx"));
const Medicines = lazy(() => import("./pages/Medicines.tsx"));
const Board = lazy(() => import("./pages/Board.tsx"));
const Desk = lazy(() => import("./pages/Desk.tsx"));
const Me = lazy(() => import("./pages/Me.tsx"));
const Admin = lazy(() => import("./pages/Admin.tsx"));

/** Mini App shell: waits for the Telegram SDK (no-op outside Telegram), then routes. */
function MiniApp() {
  const [ready, setReady] = useState(false);
  useEffect(() => { loadTelegramSdk().then(() => setReady(true)); }, []);
  if (!ready) return <div className="mini" />;
  return (
    <Routes>
      <Route path="ask/:id" element={<Board />} />
      <Route path="desk" element={<Desk />} />
      <Route path="me" element={<Me />} />
      <Route path="admin" element={<Admin />} />
      <Route path="*" element={<AppHome />} />
    </Routes>
  );
}

function AppHome() {
  const [to, setTo] = useState<string | null>(null);
  useEffect(() => { api("/me").then((m) => setTo(m.pharmacy ? "/app/desk" : "/app/me")).catch(() => setTo("/")); }, []);
  return to ? <Navigate to={to} replace /> : <div className="mini" />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Suspense fallback={<div className="mini" />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/studio" element={<Studio />} />
          <Route path="/medicines" element={<Medicines />} />
          <Route path="/app/*" element={<MiniApp />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </StrictMode>,
);
