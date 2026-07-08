import { useState, useEffect, useMemo, useRef } from "react";
import {
  QrCode, MapPin, Calendar, Clock, CheckCircle2, Plus, Trash2,
  ArrowLeft, Truck, ClipboardList, Ticket, X, DollarSign, Copy, Search,
  Tag, Share2
} from "lucide-react";
import { storageSet, storageGet, storageList, storageDelete } from "./storage";

/* ---------------------------------------------------------------
   Constants
--------------------------------------------------------------- */

const SERVICE_TYPES = [
  "Interior Cleaning",
  "Exterior Cleaning",
  "Interior + Exterior Cleaning",
  "Window Cleaning",
  "Gutter Cleaning",
  "Pressure Washing",
  "Lawn Care & Landscaping",
  "Pool Service & Maintenance",
  "Pest Control",
  "HVAC Tune-Up",
  "Custom Service",
];

const RECURRENCE_OPTIONS = [
  { id: "onetime", label: "One-Time Service", discount: 0, note: "Single visit, no commitment" },
  { id: "annually", label: "Annually", discount: 0, note: "Once a year, same price every visit" },
  { id: "quarterly", label: "Quarterly", discount: 0.10, note: "Every 3 months — 15% off each visit" },
  { id: "monthly", label: "Monthly", discount: 0.15, note: "Every month — 20% off each visit, best value" },
];

// Business day window, in minutes-from-midnight. Appointment length now comes
// from each quote's own estimated duration rather than a fixed block.
const BUSINESS_START_MIN = 8 * 60;   // 8:00 AM
const BUSINESS_END_MIN = 19 * 60;    // 7:00 PM
const START_TIME_STEP_MIN = 30;      // offer start times in 30-minute increments

/* ---------------------------------------------------------------
   Data loading (storageSet/Get/List/Delete now come from ./storage,
   which is backed by Firestore — see src/storage.js)
--------------------------------------------------------------- */

async function loadAllQuoteGroups() {
  const listRes = await storageList("quote:");
  if (!listRes || !listRes.keys) return [];
  const results = await Promise.all(listRes.keys.map((k) => storageGet(k)));
  return results
    .filter(Boolean)
    .map((r) => { try { return JSON.parse(r.value); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function loadAllBookings() {
  const listRes = await storageList("booking:");
  if (!listRes || !listRes.keys) return [];
  const results = await Promise.all(listRes.keys.map((k) => storageGet(k)));
  return results
    .filter(Boolean)
    .map((r) => { try { return JSON.parse(r.value); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/* ---------------------------------------------------------------
   Date / money helpers
--------------------------------------------------------------- */

function toISODate(d) { return d.toISOString().slice(0, 10); }
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function formatDateLabel(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
function formatDateShort(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function addInterval(iso, recurrence) {
  const d = new Date(iso + "T00:00:00");
  if (recurrence === "monthly") d.setMonth(d.getMonth() + 1);
  else if (recurrence === "quarterly") d.setMonth(d.getMonth() + 3);
  else if (recurrence === "annually") d.setFullYear(d.getFullYear() + 1);
  return toISODate(d);
}
function money(n) { return `$${n.toFixed(2)}`; }
function discountedPrice(base, recurrenceId) {
  const opt = RECURRENCE_OPTIONS.find((r) => r.id === recurrenceId) || RECURRENCE_OPTIONS[0];
  return Math.round(base * (1 - opt.discount) * 100) / 100;
}
function genCode() {
  const n = Math.floor(1000 + Math.random() * 9000);
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const l = letters[Math.floor(Math.random() * letters.length)] + letters[Math.floor(Math.random() * letters.length)];
  return `SVC-${l}${n}`;
}
function uid() { return `${Date.now()}-${Math.floor(Math.random() * 100000)}`; }

function minutesToLabel(mins) {
  let h = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function formatDuration(minutes) {
  if (!minutes && minutes !== 0) return "";
  const hrs = minutes / 60;
  return Number.isInteger(hrs) ? `${hrs} hr${hrs === 1 ? "" : "s"}` : `${hrs.toFixed(1)} hrs`;
}

const DEFAULT_DURATION_MIN = 60;

// Resilient duration lookup: use the real numeric field if present, fall back
// to parsing an old free-text duration (e.g. "2.5 hrs"), otherwise default to
// 1 hour rather than silently blocking every date.
function getDurationMinutes(quote) {
  if (!quote) return DEFAULT_DURATION_MIN;
  if (typeof quote.durationMinutes === "number" && quote.durationMinutes > 0) return quote.durationMinutes;
  if (quote.duration) {
    const match = String(quote.duration).match(/(\d+(\.\d+)?)/);
    if (match) {
      const parsed = Math.round(parseFloat(match[1]) * 60);
      if (parsed > 0) return parsed;
    }
  }
  return DEFAULT_DURATION_MIN;
}

// Existing appointments that day, as [start, end) minute ranges — using each
// booking's own duration (falling back to a default for older records that
// predate duration tracking), not a fixed length.
function bookedIntervalsForDate(bookings, dateIso) {
  return bookings
    .filter((b) => b.date === dateIso && typeof b.startMin === "number")
    .map((b) => {
      const dur = typeof b.durationMin === "number" && b.durationMin > 0 ? b.durationMin : DEFAULT_DURATION_MIN;
      return { start: b.startMin, end: b.startMin + dur };
    });
}

// Every 30-min start time that day where a block of `durationMin` is fully free,
// working around anything already booked (and its own duration) that day.
function availableStartTimes(bookings, dateIso, durationMin) {
  const dur = durationMin && durationMin > 0 ? durationMin : DEFAULT_DURATION_MIN;
  const busy = bookedIntervalsForDate(bookings, dateIso);
  const options = [];
  for (let start = BUSINESS_START_MIN; start + dur <= BUSINESS_END_MIN; start += START_TIME_STEP_MIN) {
    const end = start + dur;
    const overlaps = busy.some((b) => start < b.end && end > b.start);
    if (!overlaps) options.push(start);
  }
  return options;
}

/* ---------------------------------------------------------------
   QR Code renderer (loads qrcodejs from cdnjs)
--------------------------------------------------------------- */

function QRCodeDisplay({ value, size = 176 }) {
  const ref = useRef(null);
  const [loaded, setLoaded] = useState(typeof window !== "undefined" && !!window.QRCode);

  useEffect(() => {
    let cancelled = false;
    if (window.QRCode) { setLoaded(true); return; }
    let script = document.getElementById("qrcodejs-lib");
    if (!script) {
      script = document.createElement("script");
      script.id = "qrcodejs-lib";
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
      document.body.appendChild(script);
    }
    script.addEventListener("load", () => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (loaded && ref.current && window.QRCode) {
      ref.current.innerHTML = "";
      new window.QRCode(ref.current, {
        text: value,
        width: size,
        height: size,
        colorDark: "#14213D",
        colorLight: "#FBFAF7",
        correctLevel: window.QRCode.CorrectLevel.M,
      });
    }
  }, [loaded, value, size]);

  return (
    <div className="qr-box" style={{ width: size, height: size }}>
      {!loaded && <div className="qr-loading">Loading code…</div>}
      <div ref={ref} />
    </div>
  );
}

/* ---------------------------------------------------------------
   Small shared UI bits
--------------------------------------------------------------- */

function StripBand() {
  return (
    <div className="strip-band" aria-hidden="true">
      {Array.from({ length: 40 }).map((_, i) => <span key={i} />)}
    </div>
  );
}

function EmptyState({ icon: Icon, title, note }) {
  return (
    <div className="empty-state">
      <Icon size={28} strokeWidth={1.5} />
      <div className="empty-title">{title}</div>
      {note && <div className="empty-note">{note}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------
   Main App
--------------------------------------------------------------- */

export default function ServiceScheduler() {
  // A scanned QR code links to /?code=SVC-AB1234 — if that's present, skip the
  // landing page and go straight into the customer flow with that code.
  const initialCode = useMemo(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("code");
  }, []);

  const [view, setView] = useState(initialCode ? "customer" : "landing"); // landing | provider | customer
  const [quoteGroups, setQuoteGroups] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);

  async function refreshAll() {
    setLoading(true);
    const [groups, bks] = await Promise.all([loadAllQuoteGroups(), loadAllBookings()]);
    setQuoteGroups(groups);
    setBookings(bks);
    setLoading(false);
  }

  useEffect(() => { refreshAll(); }, []);

  return (
    <div className="app-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap');

        :root {
          --ink: #14213D;
          --paper: #FBFAF7;
          --amber: #FFB703;
          --slate: #5B6478;
          --line: #E1E4EA;
          --teal: #2A9D8F;
          --red: #C1443C;
          --panel: #FFFFFF;
        }
        * { box-sizing: border-box; }
        .app-root {
          font-family: 'Inter', sans-serif;
          background: var(--paper);
          color: var(--ink);
          min-height: 100vh;
          width: 100%;
        }
        .strip-band {
          display: flex;
          height: 6px;
          width: 100%;
          overflow: hidden;
        }
        .strip-band span {
          flex: 1;
          background: var(--ink);
        }
        .strip-band span:nth-child(4n), .strip-band span:nth-child(4n+1) {
          background: var(--amber);
        }
        h1, h2, h3, .display {
          font-family: 'Barlow Condensed', sans-serif;
          text-transform: uppercase;
          letter-spacing: 0.02em;
          color: var(--ink);
        }
        .mono { font-family: 'IBM Plex Mono', monospace; }
        button { font-family: inherit; cursor: pointer; }
        input, select, textarea { font-family: inherit; }

        .shell { max-width: 760px; margin: 0 auto; padding: 28px 20px 60px; }
        .top-nav {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 22px;
        }
        .brand {
          display: flex; align-items: center; gap: 10px;
        }
        .brand-title { font-size: 22px; font-weight: 700; line-height: 1; }
        .brand-sub { font-size: 11px; color: var(--slate); letter-spacing: 0.08em; text-transform: uppercase; }
        .back-btn {
          display: flex; align-items: center; gap: 6px;
          background: none; border: none; color: var(--slate);
          font-size: 13px; font-weight: 600; padding: 6px 0;
        }
        .back-btn:hover { color: var(--ink); }

        /* Landing */
        .landing-hero { padding: 40px 0 20px; text-align: center; }
        .landing-hero h1 { font-size: 40px; margin: 14px 0 8px; }
        .landing-hero p { color: var(--slate); font-size: 15px; max-width: 440px; margin: 0 auto; }
        .role-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 30px; }
        @media (max-width: 560px) { .role-grid { grid-template-columns: 1fr; } }
        .role-card {
          background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
          padding: 24px 18px; text-align: left; transition: border-color .15s, transform .15s;
        }
        .role-card:hover { border-color: var(--ink); transform: translateY(-2px); }
        .role-card .icon-wrap {
          width: 40px; height: 40px; border-radius: 6px; background: var(--ink);
          display: flex; align-items: center; justify-content: center; color: var(--amber); margin-bottom: 14px;
        }
        .role-card h3 { font-size: 20px; margin: 0 0 6px; }
        .role-card p { font-size: 13px; color: var(--slate); margin: 0; line-height: 1.5; }

        /* Tabs */
        .tab-row { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 22px; }
        .tab-btn {
          background: none; border: none; padding: 10px 14px; font-size: 13px; font-weight: 600;
          color: var(--slate); border-bottom: 2px solid transparent; margin-bottom: -1px;
          display: flex; align-items: center; gap: 6px;
        }
        .tab-btn.active { color: var(--ink); border-bottom-color: var(--amber); }

        /* Cards / panels */
        .panel {
          background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 20px;
        }
        .field-label {
          font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
          color: var(--slate); display: block; margin-bottom: 6px;
        }
        .field-row { margin-bottom: 16px; }
        .field-input {
          width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 4px;
          font-size: 14px; color: var(--ink); background: var(--paper);
        }
        .field-input:focus { outline: 2px solid var(--ink); outline-offset: 1px; }
        .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        @media (max-width: 560px) { .two-col { grid-template-columns: 1fr; } }

        .quote-line {
          border: 1px solid var(--line); border-radius: 5px; padding: 14px; margin-bottom: 12px;
          background: var(--paper); position: relative;
        }
        .quote-line-remove {
          position: absolute; top: 10px; right: 10px; background: none; border: none; color: var(--slate);
        }
        .quote-line-remove:hover { color: var(--red); }

        .btn {
          border: none; border-radius: 4px; padding: 11px 18px; font-size: 13px; font-weight: 700;
          text-transform: uppercase; letter-spacing: 0.05em; display: inline-flex; align-items: center; gap: 7px;
        }
        .btn-primary { background: var(--ink); color: var(--paper); }
        .btn-primary:hover { background: #1e2f56; }
        .btn-primary:disabled { background: #B7BCC7; cursor: not-allowed; }
        .btn-outline { background: none; border: 1px solid var(--ink); color: var(--ink); }
        .btn-outline:hover { background: var(--ink); color: var(--paper); }
        .btn-ghost { background: none; border: 1px dashed var(--slate); color: var(--slate); }
        .btn-full { width: 100%; justify-content: center; }
        .btn-sm { padding: 7px 12px; font-size: 12px; }

        /* Quote group list */
        .qg-addr { font-size: 12.5px; color: var(--slate); display: flex; align-items: center; gap: 4px; }

        /* Quotes page (redesigned) */
        .quotes-header {
          display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 18px;
        }
        .quotes-title {
          font-family: 'Inter', sans-serif; text-transform: none; letter-spacing: -0.01em;
          font-size: 28px; font-weight: 800; margin: 0 0 4px; color: var(--ink);
        }
        .quotes-sub { font-size: 13px; color: var(--slate); max-width: 460px; line-height: 1.5; }
        .btn-new-quote {
          flex-shrink: 0; background: var(--ink); color: var(--paper); border: none; border-radius: 6px;
          padding: 10px 16px; font-size: 13px; font-weight: 700; display: flex; align-items: center; gap: 6px;
        }
        .btn-new-quote:hover { background: #1e2f56; }

        .search-wrap { position: relative; margin-bottom: 18px; }
        .search-icon { position: absolute; left: 12px; top: 12px; color: var(--slate); }

        .quotes-grid {
          display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px;
        }

        .quote-card {
          background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px;
          position: relative;
        }
        .qc-delete {
          position: absolute; top: 12px; right: 12px; background: none; border: none; color: var(--line);
          opacity: 0; transition: opacity .15s;
        }
        .quote-card:hover .qc-delete { opacity: 1; color: var(--slate); }
        .qc-delete:hover { color: var(--red); }
        .qc-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; padding-right: 18px; }
        .qc-name { font-size: 16px; font-weight: 700; color: var(--ink); line-height: 1.3; }
        .qc-sub { font-size: 13px; color: var(--slate); margin-top: 1px; }
        .qc-address {
          font-size: 12.5px; color: #3B5BDB; display: flex; align-items: center; gap: 4px; margin-top: 8px;
        }
        .status-pill {
          font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 20px; white-space: nowrap;
        }
        .status-pill.pending { background: #FFF3D6; color: #8a6200; }
        .status-pill.scheduled { background: #DFF3EE; color: #1b7d6f; }

        .qc-lines { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
        .qc-line {
          background: #F5F4F0; border-radius: 6px; padding: 8px 10px; display: flex; justify-content: space-between;
          align-items: center; gap: 8px; font-size: 12.5px;
        }
        .qc-line-left { display: flex; align-items: center; gap: 6px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .qc-line-right { display: flex; align-items: center; gap: 10px; color: var(--slate); flex-shrink: 0; }
        .qc-line-right span { display: flex; align-items: center; gap: 2px; }
        .booked-chip {
          background: var(--teal); color: #fff; font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 20px;
        }

        .qc-actions { display: flex; gap: 8px; margin-top: 14px; }
        .qc-btn-qr {
          flex: 1; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 9px 10px;
          font-size: 12.5px; font-weight: 700; display: flex; align-items: center; justify-content: center; gap: 6px; color: var(--ink);
        }
        .qc-btn-qr:hover { border-color: var(--ink); }
        .qc-icon-btn {
          background: var(--panel); border: 1px solid var(--line); border-radius: 6px; width: 36px; height: 36px;
          display: flex; align-items: center; justify-content: center; color: var(--slate); flex-shrink: 0;
        }
        .qc-icon-btn:hover { border-color: var(--ink); color: var(--ink); }

        /* Modal */
        .modal-backdrop {
          position: fixed; inset: 0; background: rgba(20,33,61,0.55); display: flex;
          align-items: center; justify-content: center; z-index: 50; padding: 20px;
        }
        .modal {
          background: var(--panel); border-radius: 8px; max-width: 340px; width: 100%; padding: 24px;
          position: relative; text-align: center;
        }
        .modal-close { position: absolute; top: 12px; right: 12px; background: none; border: none; color: var(--slate); }
        .qr-box { margin: 14px auto; display: flex; align-items: center; justify-content: center; }
        .qr-loading { font-size: 12px; color: var(--slate); }
        .code-display {
          font-size: 20px; font-weight: 700; letter-spacing: 0.05em; margin: 10px 0 4px;
        }

        /* Route board */
        .rb-date-group { margin-bottom: 20px; }
        .rb-date-head {
          display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700;
          text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink); margin-bottom: 8px;
          padding-bottom: 6px; border-bottom: 1px solid var(--line);
        }
        .cluster-badge {
          background: var(--amber); color: var(--ink); font-size: 10.5px; font-weight: 700;
          padding: 2px 7px; border-radius: 20px;
        }
        .rb-job {
          display: flex; justify-content: space-between; align-items: center; padding: 9px 0;
          border-bottom: 1px solid #F1EFE9; font-size: 13px;
        }
        .rb-job:last-child { border-bottom: none; }
        .rb-job-addr { color: var(--slate); font-size: 12px; }

        /* Customer flow */
        .stepper { display: flex; gap: 6px; margin-bottom: 24px; }
        .step-dot {
          flex: 1; height: 4px; border-radius: 3px; background: var(--line);
        }
        .step-dot.done { background: var(--ink); }
        .step-dot.active { background: var(--amber); }

        .code-entry-box {
          display: flex; gap: 8px; margin-top: 6px;
        }
        .code-entry-box input { text-transform: uppercase; letter-spacing: 0.08em; font-family: 'IBM Plex Mono', monospace; }

        .quote-option-card {
          border: 1px solid var(--line); border-radius: 6px; padding: 16px; margin-bottom: 12px; cursor: pointer;
          transition: border-color .15s;
        }
        .quote-option-card:hover { border-color: var(--ink); }
        .quote-option-card.selected { border-color: var(--ink); border-width: 2px; background: #F8F7F2; }
        .qo-top { display: flex; justify-content: space-between; align-items: baseline; }
        .qo-service { font-size: 16px; font-weight: 700; }
        .qo-duration { font-size: 12px; color: var(--slate); margin-top: 2px; }
        .qo-price { font-size: 20px; font-weight: 700; font-family: 'IBM Plex Mono', monospace; }

        .recurrence-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
        @media (max-width: 480px) { .recurrence-grid { grid-template-columns: 1fr; } }
        .recurrence-opt {
          border: 1px solid var(--line); border-radius: 5px; padding: 10px; text-align: left; background: var(--panel);
        }
        .recurrence-opt.selected { border-color: var(--teal); background: #EAF6F4; }
        .recurrence-opt .rlabel { font-size: 12.5px; font-weight: 700; }
        .recurrence-opt .rnote { font-size: 10.5px; color: var(--slate); margin-top: 2px; }
        .recurrence-opt .rprice { font-family: 'IBM Plex Mono', monospace; font-size: 13px; margin-top: 6px; }
        .strike { text-decoration: line-through; color: var(--slate); font-size: 11px; margin-right: 5px; }

        .recommend-strip { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; margin: 10px 0 18px; }
        .recommend-chip {
          flex-shrink: 0; border: 1px solid var(--amber); background: #FFF6E0; border-radius: 6px;
          padding: 8px 12px; text-align: center; min-width: 84px;
        }
        .recommend-chip .rc-date { font-size: 13px; font-weight: 700; }
        .recommend-chip .rc-count { font-size: 10.5px; color: #8a6200; margin-top: 2px; }

        .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px; }
        .cal-dow { font-size: 10px; text-align: center; color: var(--slate); font-weight: 700; text-transform: uppercase; }
        .cal-cell {
          border: 1px solid var(--line); border-radius: 5px; padding: 6px 4px; text-align: center; background: var(--panel);
          position: relative; min-height: 46px; display: flex; flex-direction: column; align-items: center; justify-content: center;
        }
        .cal-cell.selected { background: var(--ink); border-color: var(--ink); }
        .cal-cell.selected .cal-daynum { color: var(--paper); }
        .cal-cell.has-nearby { border-color: var(--amber); }
        .cal-daynum { font-size: 13px; font-weight: 600; }
        .cal-dot-row { display: flex; gap: 2px; margin-top: 3px; }
        .cal-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--amber); }

        .time-chip-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
        .time-chip {
          border: 1px solid var(--line); border-radius: 20px; padding: 8px 14px; font-size: 12.5px;
          font-weight: 600; background: var(--panel); color: var(--ink);
        }
        .time-chip:hover { border-color: var(--ink); }
        .time-chip.selected { background: var(--teal); border-color: var(--teal); color: #fff; }

        .ticket {
          border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-top: 10px;
        }
        .ticket-body { padding: 20px; }
        .ticket-row { display: flex; justify-content: space-between; font-size: 13px; padding: 7px 0; border-bottom: 1px dashed var(--line); }
        .ticket-row:last-child { border-bottom: none; }
        .ticket-row .k { color: var(--slate); }
        .ticket-row .v { font-weight: 700; }
        .confirm-icon { display: flex; justify-content: center; margin: 10px 0 4px; color: var(--teal); }

        .error-text { color: var(--red); font-size: 12.5px; margin-top: 6px; }
        .helper-text { color: var(--slate); font-size: 12.5px; margin-top: 6px; }

        .qr-print-card { padding: 4px 0; }
        .qr-print-address { font-size: 13px; color: var(--ink); margin-top: 8px; line-height: 1.4; }

        @media print {
          body * { visibility: hidden; }
          #qr-print-area, #qr-print-area * { visibility: visible; }
          #qr-print-area {
            position: fixed; top: 0; left: 0; width: 100%; padding: 60px 20px;
            display: flex; flex-direction: column; align-items: center; text-align: center;
          }
          .no-print { display: none !important; }
          .modal-backdrop { position: static; background: none; padding: 0; }
          .modal { box-shadow: none; border: none; max-width: none; padding: 0; }
        }
      `}</style>

      {view === "landing" && <Landing onPick={setView} />}
      {view === "provider" && (
        <ProviderApp
          quoteGroups={quoteGroups}
          bookings={bookings}
          loading={loading}
          onBack={() => setView("landing")}
          onRefresh={refreshAll}
        />
      )}
      {view === "customer" && (
        <CustomerApp
          quoteGroups={quoteGroups}
          bookings={bookings}
          loading={loading}
          initialCode={initialCode}
          onBack={() => setView("landing")}
          onRefresh={refreshAll}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   Landing
--------------------------------------------------------------- */

function Landing({ onPick }) {
  return (
    <div className="shell">
      <StripBand />
      <div className="landing-hero">
        <div className="brand-sub">Route Board · Field Service Scheduling</div>
        <h1>Quote it once.<br />Schedule it smart.</h1>
        <p>Build a quote, hand over a QR code, and let the calendar cluster new jobs around the routes you're already running.</p>
      </div>
      <div className="role-grid">
        <button className="role-card" onClick={() => onPick("provider")}>
          <div className="icon-wrap"><ClipboardList size={20} /></div>
          <h3>I'm the Provider</h3>
          <p>Create quotes by service type, generate a QR code per customer, and manage your route board.</p>
        </button>
        <button className="role-card" onClick={() => onPick("customer")}>
          <div className="icon-wrap"><QrCode size={20} /></div>
          <h3>I'm the Customer</h3>
          <p>Enter your quote code, pick a service option and recurrence, then choose a date on the route.</p>
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   Provider App
--------------------------------------------------------------- */

function ProviderApp({ quoteGroups, bookings, loading, onBack, onRefresh }) {
  const [tab, setTab] = useState("new");
  const [qrModalGroup, setQrModalGroup] = useState(null);

  return (
    <div className="shell">
      <div className="top-nav">
        <div className="brand">
          <div className="icon-wrap" style={{ width: 34, height: 34, background: "var(--ink)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--amber)" }}>
            <Truck size={17} />
          </div>
          <div>
            <div className="brand-title">Provider Console</div>
            <div className="brand-sub">Route Board</div>
          </div>
        </div>
        <button className="back-btn" onClick={onBack}><ArrowLeft size={14} /> Home</button>
      </div>

      <div className="tab-row">
        <button className={`tab-btn ${tab === "new" ? "active" : ""}`} onClick={() => setTab("new")}>
          <Plus size={14} /> New Quote
        </button>
        <button className={`tab-btn ${tab === "manage" ? "active" : ""}`} onClick={() => setTab("manage")}>
          <QrCode size={14} /> Quotes
        </button>
        <button className={`tab-btn ${tab === "route" ? "active" : ""}`} onClick={() => setTab("route")}>
          <Calendar size={14} /> Route Board
        </button>
      </div>

      {tab === "new" && <NewQuoteForm onSaved={(group) => { onRefresh(); setTab("manage"); setQrModalGroup(group); }} />}
      {tab === "manage" && (
        <ManageQuotes
          quoteGroups={quoteGroups}
          bookings={bookings}
          loading={loading}
          onOpenQR={setQrModalGroup}
          onRefresh={onRefresh}
          onNewQuote={() => setTab("new")}
        />
      )}
      {tab === "route" && <RouteBoard bookings={bookings} loading={loading} />}

      {qrModalGroup && (
        <QRModal group={qrModalGroup} onClose={() => setQrModalGroup(null)} />
      )}
    </div>
  );
}

function NewQuoteForm({ onSaved }) {
  const [customerName, setCustomerName] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [zip, setZip] = useState("");
  const [lines, setLines] = useState([{ id: uid(), serviceType: SERVICE_TYPES[0], price: "", durationHours: "", notes: "" }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function updateLine(id, patch) {
    setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((ls) => [...ls, { id: uid(), serviceType: SERVICE_TYPES[0], price: "", durationHours: "", notes: "" }]);
  }
  function removeLine(id) {
    setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.id !== id) : ls));
  }

  async function handleSave() {
    setError("");
    if (!address.trim() || !city.trim() || !zip.trim()) {
      setError("Please fill in the property's full address.");
      return;
    }
    const validLines = lines.filter((l) => l.serviceType && Number(l.price) > 0 && Number(l.durationHours) > 0);
    if (validLines.length === 0) {
      setError("Add at least one quote option with a service type, price, and duration.");
      return;
    }
    setSaving(true);
    const code = genCode();
    const group = {
      code,
      customerName: customerName.trim(),
      address: address.trim(),
      city: city.trim(),
      zip: zip.trim(),
      createdAt: Date.now(),
      quotes: validLines.map((l) => ({
        id: l.id,
        serviceType: l.serviceType,
        price: Number(l.price),
        durationMinutes: Math.round(Number(l.durationHours) * 60),
        notes: l.notes.trim(),
      })),
    };
    await storageSet(`quote:${code}`, JSON.stringify(group));
    setSaving(false);
    onSaved(group);
  }

  return (
    <div className="panel">
      <h2 style={{ fontSize: 20, marginTop: 0 }}>New Customer Quote</h2>

      <div className="field-row">
        <label className="field-label">Customer Name (optional)</label>
        <input className="field-input" value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Leave blank if you're just quoting the address" />
      </div>
      <div className="field-row">
        <label className="field-label">Street Address</label>
        <input className="field-input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="418 Sego Lily Dr" />
      </div>
      <div className="two-col field-row">
        <div>
          <label className="field-label">City</label>
          <input className="field-input" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Saint George" />
        </div>
        <div>
          <label className="field-label">Zip Code</label>
          <input className="field-input" value={zip} onChange={(e) => setZip(e.target.value)} placeholder="84770" />
        </div>
      </div>

      <div style={{ marginTop: 20, marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <label className="field-label" style={{ marginBottom: 0 }}>Quote Options (this QR code)</label>
      </div>
      <div className="helper-text" style={{ marginTop: -4, marginBottom: 12 }}>
        Add every option you want the customer to be able to choose from — e.g. Exterior Only vs. Interior + Exterior.
      </div>

      {lines.map((line, idx) => (
        <div className="quote-line" key={line.id}>
          {lines.length > 1 && (
            <button className="quote-line-remove" onClick={() => removeLine(line.id)}><Trash2 size={15} /></button>
          )}
          <div className="field-label">Option {idx + 1}</div>
          <div className="two-col field-row">
            <div>
              <label className="field-label">Service Type</label>
              <select className="field-input" value={line.serviceType} onChange={(e) => updateLine(line.id, { serviceType: e.target.value })}>
                {SERVICE_TYPES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="field-label">Estimated Duration (hours)</label>
              <input className="field-input" type="number" min="0.25" step="0.25" value={line.durationHours} onChange={(e) => updateLine(line.id, { durationHours: e.target.value })} placeholder="e.g. 2.5" />
            </div>
          </div>
          <div className="field-row">
            <label className="field-label">Base Price (per visit)</label>
            <input className="field-input" type="number" min="0" step="0.01" value={line.price} onChange={(e) => updateLine(line.id, { price: e.target.value })} placeholder="150.00" />
          </div>
          <div>
            <label className="field-label">Notes (optional)</label>
            <input className="field-input" value={line.notes} onChange={(e) => updateLine(line.id, { notes: e.target.value })} placeholder="Includes baseboards and window tracks" />
          </div>
        </div>
      ))}

      <button className="btn btn-ghost btn-full" onClick={addLine}><Plus size={14} /> Add Another Quote Option</button>

      {error && <div className="error-text">{error}</div>}

      <div style={{ marginTop: 18 }}>
        <button className="btn btn-primary btn-full" disabled={saving} onClick={handleSave}>
          <QrCode size={15} /> {saving ? "Generating…" : "Generate QR Code"}
        </button>
      </div>
    </div>
  );
}

function ManageQuotes({ quoteGroups, bookings, loading, onOpenQR, onRefresh, onNewQuote }) {
  const [search, setSearch] = useState("");

  const filtered = quoteGroups.filter((g) => {
    const q = search.toLowerCase();
    return !q || g.customerName.toLowerCase().includes(q) || g.code.toLowerCase().includes(q) || g.address.toLowerCase().includes(q);
  });

  async function handleDelete(code) {
    await storageDelete(`quote:${code}`);
    onRefresh();
  }

  function shareCode(code) {
    const text = `Here's your service quote code: ${code}. Enter it on the booking page to view your options and pick a date.`;
    if (navigator.share) {
      navigator.share({ title: "Service Quote", text }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
    }
  }

  if (loading) return <div className="helper-text">Loading quotes…</div>;

  return (
    <div>
      <div className="quotes-header">
        <div>
          <h1 className="quotes-title">Quotes</h1>
          <div className="quotes-sub">Create a quote with multiple options and share one QR code so customers can self-schedule.</div>
        </div>
        <button className="btn-new-quote" onClick={onNewQuote}><Plus size={15} /> New quote</button>
      </div>

      <div className="search-wrap">
        <Search size={15} className="search-icon" />
        <input className="field-input" style={{ paddingLeft: 34 }} placeholder="Search by customer, code, or address" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {filtered.length === 0 && (
        <EmptyState icon={QrCode} title="No quotes yet" note="Create a new quote to generate a shareable QR code." />
      )}

      <div className="quotes-grid">
        {filtered.map((g) => {
          const groupBookings = bookings.filter((b) => b.code === g.code);
          const isScheduled = groupBookings.length > 0;
          const distinctServices = [...new Set(g.quotes.map((q) => q.serviceType))];
          const headline = g.customerName || (distinctServices.length === 1 ? distinctServices[0] : "Multiple Services");
          const subline = g.customerName ? (distinctServices.length === 1 ? distinctServices[0] : "Multiple Services") : null;

          return (
            <div className="quote-card" key={g.code}>
              <button className="qc-delete" onClick={() => handleDelete(g.code)} title="Delete quote"><Trash2 size={13} /></button>

              <div className="qc-top">
                <div className="qc-name">{headline}</div>
                <span className={`status-pill ${isScheduled ? "scheduled" : "pending"}`}>{isScheduled ? "Scheduled" : "Pending"}</span>
              </div>
              {subline && <div className="qc-sub">{subline}</div>}
              <div className="qc-address"><MapPin size={12} /> {g.address}, {g.city} {g.zip}</div>

              <div className="qc-lines">
                {g.quotes.map((q) => {
                  const booked = groupBookings.some((b) => b.quoteId === q.id);
                  return (
                    <div className="qc-line" key={q.id}>
                      <span className="qc-line-left"><Tag size={12} /> {q.serviceType}</span>
                      <span className="qc-line-right">
                        <span><DollarSign size={11} />{q.price.toFixed(0)}</span>
                        <span><Clock size={11} />{formatDuration(getDurationMinutes(q))}</span>
                        {booked && <span className="booked-chip">Booked</span>}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="qc-actions">
                <button className="qc-btn-qr" onClick={() => onOpenQR(g)}><QrCode size={14} /> Show QR</button>
                <button className="qc-icon-btn" title="Copy code" onClick={() => navigator.clipboard && navigator.clipboard.writeText(g.code)}><Copy size={14} /></button>
                <button className="qc-icon-btn" title="Share code" onClick={() => shareCode(g.code)}><Share2 size={14} /></button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function bookingUrlForCode(code) {
  const base = import.meta.env.BASE_URL || "/";
  return `${window.location.origin}${base}?code=${encodeURIComponent(code)}`;
}

function QRModal({ group, onClose }) {
  const [copied, setCopied] = useState(false);
  const code = group.code;
  const url = bookingUrlForCode(code);

  function copyLink() {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close no-print" onClick={onClose}><X size={18} /></button>

        <div id="qr-print-area" className="qr-print-card">
          <div className="brand-sub">Scan to book your service</div>
          <QRCodeDisplay value={url} />
          <div className="code-display mono">{code}</div>
          {(group.customerName || group.address) && (
            <div className="qr-print-address">
              {group.customerName && <div>{group.customerName}</div>}
              {group.address && <div>{group.address}{group.city ? `, ${group.city}` : ""} {group.zip || ""}</div>}
            </div>
          )}
          <div className="helper-text">Scan with any phone camera, or go to {url.replace(/^https?:\/\//, "")} and enter code {code}.</div>
        </div>

        <div className="no-print" style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button className="btn btn-outline" style={{ flex: 1 }} onClick={copyLink}>
            <Copy size={13} /> {copied ? "Copied!" : "Copy Link"}
          </button>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => window.print()}>
            Print QR Code
          </button>
        </div>
      </div>
    </div>
  );
}

function RouteBoard({ bookings, loading }) {
  if (loading) return <div className="helper-text">Loading route board…</div>;
  if (bookings.length === 0) {
    return <EmptyState icon={Truck} title="No jobs scheduled yet" note="Bookings will appear here once customers pick a date." />;
  }

  const byDate = {};
  bookings.forEach((b) => { (byDate[b.date] = byDate[b.date] || []).push(b); });
  const dates = Object.keys(byDate).sort();

  return (
    <div>
      {dates.map((date) => {
        const jobs = byDate[date];
        const zipCounts = {};
        jobs.forEach((j) => { zipCounts[j.zip] = (zipCounts[j.zip] || 0) + 1; });
        return (
          <div className="rb-date-group" key={date}>
            <div className="rb-date-head">
              <Calendar size={14} /> {formatDateLabel(date)}
              <span className="cluster-badge">{jobs.length} job{jobs.length > 1 ? "s" : ""}</span>
            </div>
            {jobs.map((j) => (
              <div className="rb-job" key={j.id}>
                <div>
                  <div>{j.customerName || j.address} — {j.serviceType}</div>
                  <div className="rb-job-addr">
                    <MapPin size={11} style={{ display: "inline", marginRight: 3 }} />
                    {j.address}, {j.zip} {zipCounts[j.zip] > 1 && <span style={{ color: "#8a6200", fontWeight: 700 }}> · clustered ({zipCounts[j.zip]})</span>}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="mono" style={{ fontWeight: 700 }}>{money(j.price)}</div>
                  <div className="rb-job-addr">{j.slot}</div>
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------
   Customer App
--------------------------------------------------------------- */

function AppointmentDetails({
    booking,
    group,
    onReschedule,
    onChangeService,
    onCancel,
    submitting
}) {
  return (<div className="panel">

    <div className="confirm-icon">
        <CheckCircle2 size={44}/>
    </div>

    <h2>Your Appointment</h2>

    <div className="ticket">

        <div className="ticket-body">

            <div className="ticket-row">
                <span className="k">Service</span>
                <span className="v">{booking.serviceType}</span>
            </div>

            <div className="ticket-row">
                <span className="k">Date</span>
                <span className="v">{formatDateLabel(booking.date)}</span>
            </div>

            <div className="ticket-row">
                <span className="k">Time</span>
                <span className="v">{booking.slot}</span>
            </div>

            <div className="ticket-row">
                <span className="k">Frequency</span>
                <span className="v">
                    {RECURRENCE_OPTIONS.find(r => r.id === booking.recurrence)?.label}
                </span>
            </div>

            <div className="ticket-row">
                <span className="k">Price</span>
                <span className="v">{money(booking.price)}</span>
            </div>

            <div className="ticket-row">
                <span className="k">Address</span>
                <span className="v">
                    {group.address}
                </span>
            </div>

        </div>

    </div>

    <button
        className="btn btn-primary btn-full"
        style={{marginTop:20}}
        onClick={onReschedule}
        disabled={submitting}
    >
        Reschedule
    </button>

    <button
        className="btn btn-outline btn-full"
        style={{marginTop:10}}
        onClick={onChangeService}
        disabled={submitting}
    >
        Change Service
    </button>

    <button
        className="btn btn-outline btn-full"
        style={{
            marginTop:10,
            borderColor:"var(--red)",
            color:"var(--red)"
        }}
        onClick={onCancel}
        disabled={submitting}
    >
        {submitting ? "Cancelling…" : "Cancel Appointment"}
    </button>

</div>)
}


function CustomerApp({ quoteGroups, bookings, loading, initialCode, onBack, onRefresh }) {
  const [step, setStep] = useState("code"); // code -> select -> schedule -> confirmed
  const [enteredCode, setEnteredCode] = useState("");
  const [error, setError] = useState("");
  const [group, setGroup] = useState(null);
  const [selectedQuoteId, setSelectedQuoteId] = useState(null);
  const [recurrenceId, setRecurrenceId] = useState("onetime");
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedStartMin, setSelectedStartMin] = useState(null);
  const [confirmedBooking, setConfirmedBooking] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  // When set, confirming goes through handleConfirmBooking as an UPDATE to this
  // existing booking (reschedule / change service) instead of creating a new one.
  const [editingBookingId, setEditingBookingId] = useState(null);

  function findGroup(codeRaw) {
    const code = codeRaw.trim().toUpperCase().replace(/^QUOTE:/, "");
    const found = quoteGroups.find((g) => g.code.toUpperCase() === code);
    return found;
  }

  function handleLookup(codeOverride) {
    setError("");
    const found = findGroup(codeOverride ?? enteredCode);
    if (!found) {
      setError("We couldn't find a quote with that code. Double-check and try again.");
      return;
    }
    const existingBooking = bookings.find((b) => b.code === found.code);
    setGroup(found);
    if (existingBooking) {
      setConfirmedBooking(existingBooking);
      setStep("appointment");
      return;
    }
    
    setSelectedQuoteId(found.quotes[0].id);
    setStep("select");
  }

  // A scanned QR code (?code=SVC-AB1234) lands here — run the same lookup
  // automatically once the shared data has finished loading, instead of
  // making the customer retype the code they just scanned.
  const [autoLookupDone, setAutoLookupDone] = useState(false);
  useEffect(() => {
    if (!initialCode || autoLookupDone || loading) return;
    setAutoLookupDone(true);
    setEnteredCode(initialCode);
    handleLookup(initialCode);
    // Clean the URL so refreshing / going Home doesn't keep re-triggering this.
    if (typeof window !== "undefined" && window.history?.replaceState) {
      const url = new URL(window.location.href);
      url.searchParams.delete("code");
      window.history.replaceState({}, "", url.pathname + url.search);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode, loading, autoLookupDone, quoteGroups, bookings]);

  const selectedQuote = group ? group.quotes.find((q) => q.id === selectedQuoteId) : null;

  async function handleConfirmBooking() {
    if (!selectedDate || selectedStartMin == null || !selectedQuote) return;
    setSubmitting(true);
    const durationMin = getDurationMinutes(selectedQuote);
    // Reschedule / change-service edits reuse the original booking's id so this
    // overwrites the same storage record instead of creating a second booking
    // for the same QR code.
    const booking = {
      id: editingBookingId || uid(),
      code: group.code,
      quoteId: selectedQuote.id,
      serviceType: selectedQuote.serviceType,
      durationMin,
      customerName: group.customerName,
      address: group.address,
      city: group.city,
      zip: group.zip,
      recurrence: recurrenceId,
      price: discountedPrice(selectedQuote.price, recurrenceId),
      basePrice: selectedQuote.price,
      date: selectedDate,
      startMin: selectedStartMin,
      slot: `${minutesToLabel(selectedStartMin)} – ${minutesToLabel(selectedStartMin + durationMin)}`,
      createdAt: Date.now(),
    };
    await storageSet(`booking:${booking.id}`, JSON.stringify(booking));
    setSubmitting(false);
    setConfirmedBooking(booking);
    setEditingBookingId(null);
    await onRefresh();
    setStep("confirmed");
  }

  async function handleCancelBooking() {
    if (!confirmedBooking) return;
    const ok = window.confirm("Cancel this appointment? This can't be undone.");
    if (!ok) return;
    setSubmitting(true);
    await storageDelete(`booking:${confirmedBooking.id}`);
    setSubmitting(false);
    setConfirmedBooking(null);
    setEditingBookingId(null);
    await onRefresh();
    // Send them back into the booking flow with the same code/group so they
    // can immediately rebook if they want to.
    setSelectedQuoteId(group.quotes[0].id);
    setSelectedDate(null);
    setSelectedStartMin(null);
    setStep("select");
  }

  const stepIndex = { code: 0, select: 1, schedule: 2, confirmed: 3, appointment: 3 }[step];

  return (
    <div className="shell">
      <div className="top-nav">
        <div className="brand">
          <div style={{ width: 34, height: 34, background: "var(--ink)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--amber)" }}>
            <Ticket size={17} />
          </div>
          <div>
            <div className="brand-title">Book Your Service</div>
            <div className="brand-sub">Route Board</div>
          </div>
        </div>
        <button className="back-btn" onClick={onBack}><ArrowLeft size={14} /> Home</button>
      </div>

      <div className="stepper">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`step-dot ${i < stepIndex ? "done" : i === stepIndex ? "active" : ""}`} />
        ))}
      </div>

      {step === "code" && (
        <div className="panel">
          <h2 style={{ fontSize: 20, marginTop: 0 }}>Enter Your Quote Code</h2>
          <p className="helper-text" style={{ marginTop: -4 }}>
            Scan the QR code your provider gave you, or type the code printed underneath it.
          </p>
          <div className="code-entry-box">
            <input
              className="field-input"
              placeholder="SVC-AB1234"
              value={enteredCode}
              onChange={(e) => setEnteredCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleLookup()}
            />
            <button className="btn btn-primary" onClick={handleLookup}><Search size={14} /> Find</button>
          </div>
          {error && <div className="error-text">{error}</div>}
        </div>
      )}

      {step === "select" && group && (
        <div>
          <div className="panel" style={{ marginBottom: 16 }}>
            <div className="brand-sub">Quote for</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{group.customerName || "Your Property"}</div>
            <div className="qg-addr"><MapPin size={12} /> {group.address}, {group.city} {group.zip}</div>
          </div>

          <h2 style={{ fontSize: 18 }}>Choose Your Service</h2>
          {group.quotes.map((q) => (
            <div
              key={q.id}
              className={`quote-option-card ${selectedQuoteId === q.id ? "selected" : ""}`}
              onClick={() => setSelectedQuoteId(q.id)}
            >
              <div className="qo-top">
                <div className="qo-service">{q.serviceType}</div>
                <div className="qo-price mono">{money(q.price)}</div>
              </div>
              <div className="qo-duration"><Clock size={11} style={{ display: "inline", marginRight: 3 }} />Est. {formatDuration(getDurationMinutes(q))}</div>
              {q.notes && <div className="helper-text">{q.notes}</div>}
            </div>
          ))}

          <h2 style={{ fontSize: 18, marginTop: 20 }}>How Often?</h2>
          <div className="recurrence-grid">
            {RECURRENCE_OPTIONS.map((r) => {
              const price = discountedPrice(selectedQuote?.price || 0, r.id);
              return (
                <button
                  key={r.id}
                  className={`recurrence-opt ${recurrenceId === r.id ? "selected" : ""}`}
                  onClick={() => setRecurrenceId(r.id)}
                >
                  <div className="rlabel">{r.label}</div>
                  <div className="rnote">{r.note}</div>
                  <div className="rprice mono">
                    {r.discount > 0 && <span className="strike">{money(selectedQuote?.price || 0)}</span>}
                    {money(price)} / visit
                  </div>
                </button>
              );
            })}
          </div>

          <button className="btn btn-primary btn-full" style={{ marginTop: 20 }} onClick={() => setStep("schedule")}>
            Continue to Scheduling
          </button>
        </div>
      )}

      {step === "schedule" && group && (
        <ScheduleStep
          group={group}
          bookings={bookings}
          durationMin={getDurationMinutes(selectedQuote)}
          selectedDate={selectedDate}
          setSelectedDate={setSelectedDate}
          selectedStartMin={selectedStartMin}
          setSelectedStartMin={setSelectedStartMin}
          onBack={() => setStep("select")}
          onConfirm={handleConfirmBooking}
          submitting={submitting}
        />
      )}

      {step === "confirmed" && confirmedBooking && (
        <ConfirmationStep booking={confirmedBooking} />
      )}

      {step === "appointment" &&
    confirmedBooking && (
        <AppointmentDetails
            booking={confirmedBooking}
            group={group}
            submitting={submitting}
            onReschedule={() => {
                setEditingBookingId(confirmedBooking.id);
                setSelectedQuoteId(confirmedBooking.quoteId);
                setRecurrenceId(confirmedBooking.recurrence);
                setSelectedDate(confirmedBooking.date);
                setSelectedStartMin(confirmedBooking.startMin);
                setStep("schedule");
            }}
            onChangeService={() => {
                setEditingBookingId(confirmedBooking.id);
                setSelectedQuoteId(confirmedBooking.quoteId);
                setRecurrenceId(confirmedBooking.recurrence);
                setStep("select");
            }}
            onCancel={handleCancelBooking}
        />
)}
    </div>
  );
}

function ScheduleStep({ group, bookings, durationMin, selectedDate, setSelectedDate, selectedStartMin, setSelectedStartMin, onBack, onConfirm, submitting }) {
  const days = useMemo(() => {
    const arr = [];
    const start = addDays(new Date(), 1);
    for (let i = 0; i < 45; i++) arr.push(toISODate(addDays(start, i)));
    return arr;
  }, []);

  function nearbyCount(dateIso) {
    return bookings.filter((b) => b.zip === group.zip && b.date === dateIso).length;
  }

  const recommended = days
    .map((d) => ({ date: d, count: nearbyCount(d) }))
    .filter((d) => d.count > 0)
    .sort((a, b) => b.count - a.count || a.date.localeCompare(b.date))
    .slice(0, 4);

  // pad leading blanks so the grid lines up to real weekdays
  const firstDow = new Date(days[0] + "T00:00:00").getDay();
  const leadingBlanks = Array.from({ length: firstDow });

  const openStartTimes = selectedDate ? availableStartTimes(bookings, selectedDate, durationMin) : [];

  return (
    <div>
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="brand-sub">Scheduling for</div>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{group.address}, {group.city} {group.zip}</div>
      </div>

      {recommended.length > 0 && (
        <>
          <h2 style={{ fontSize: 16 }}><MapPin size={14} style={{ display: "inline", marginRight: 4 }} />Recommended — Crew Already Nearby</h2>
          <div className="recommend-strip">
            {recommended.map((r) => (
              <button key={r.date} className="recommend-chip" onClick={() => { setSelectedDate(r.date); setSelectedStartMin(null); }}>
                <div className="rc-date">{formatDateShort(r.date)}</div>
                <div className="rc-count">{r.count} nearby job{r.count > 1 ? "s" : ""}</div>
              </button>
            ))}
          </div>
        </>
      )}

      <h2 style={{ fontSize: 16 }}>Pick a Date</h2>
      <div className="cal-grid" style={{ marginBottom: 4 }}>
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <div className="cal-dow" key={i}>{d}</div>)}
      </div>
      <div className="cal-grid">
        {leadingBlanks.map((_, i) => <div key={`b${i}`} />)}
        {days.map((d) => {
          const count = nearbyCount(d);
          const dayNum = new Date(d + "T00:00:00").getDate();
          return (
            <button
              key={d}
              className={`cal-cell ${selectedDate === d ? "selected" : ""} ${count > 0 ? "has-nearby" : ""}`}
              onClick={() => { setSelectedDate(d); setSelectedStartMin(null); }}
            >
              <div className="cal-daynum">{dayNum}</div>
              {count > 0 && (
                <div className="cal-dot-row">
                  {Array.from({ length: Math.min(count, 4) }).map((_, i) => <span className="cal-dot" key={i} />)}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {selectedDate && (
        <>
          <h2 style={{ fontSize: 16, marginTop: 22 }}>Pick a Start Time — {formatDateLabel(selectedDate)}</h2>
          <div className="helper-text" style={{ marginTop: -6, marginBottom: 10 }}>
            This job needs a {formatDuration(durationMin)} window. Times shown already work around anything booked earlier that day.
          </div>
          {openStartTimes.length === 0 ? (
            <div className="helper-text">That day is fully booked — try another date.</div>
          ) : (
            <div className="time-chip-grid">
              {openStartTimes.map((t) => (
                <button
                  key={t}
                  className={`time-chip ${selectedStartMin === t ? "selected" : ""}`}
                  onClick={() => setSelectedStartMin(t)}
                >
                  {minutesToLabel(t)}
                </button>
              ))}
            </div>
          )}
          {selectedStartMin != null && (
            <div className="helper-text" style={{ marginTop: 10 }}>
              <Clock size={12} style={{ display: "inline", marginRight: 4 }} />
              Booked window: {minutesToLabel(selectedStartMin)} – {minutesToLabel(selectedStartMin + durationMin)}
            </div>
          )}
        </>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
        <button className="btn btn-outline" onClick={onBack}>Back</button>
        <button
          className="btn btn-primary btn-full"
          disabled={!selectedDate || selectedStartMin == null || submitting}
          onClick={onConfirm}
        >
          <CheckCircle2 size={15} /> {submitting ? "Booking…" : "Confirm Booking"}
        </button>
      </div>
    </div>
  );
}

function ConfirmationStep({ booking }) {
  const nextDate = booking.recurrence !== "onetime" ? addInterval(booking.date, booking.recurrence) : null;
  const recurrenceLabel = RECURRENCE_OPTIONS.find((r) => r.id === booking.recurrence)?.label;

  return (
    <div>
      <div className="confirm-icon"><CheckCircle2 size={40} strokeWidth={1.5} /></div>
      <h1 style={{ textAlign: "center", fontSize: 26, marginTop: 0 }}>Booked!</h1>
      <p style={{ textAlign: "center", color: "var(--slate)", fontSize: 13, marginTop: -6 }}>
        A confirmation has been added to your provider's route board.
      </p>

      <div className="ticket">
        <StripBand />
        <div className="ticket-body">
          <div className="ticket-row"><span className="k">Service</span><span className="v">{booking.serviceType}</span></div>
          <div className="ticket-row"><span className="k">Duration</span><span className="v">{formatDuration(booking.durationMin)}</span></div>
          <div className="ticket-row"><span className="k">Address</span><span className="v">{booking.address}</span></div>
          <div className="ticket-row"><span className="k">Date</span><span className="v">{formatDateLabel(booking.date)}</span></div>
          <div className="ticket-row"><span className="k">Time</span><span className="v">{booking.slot}</span></div>
          <div className="ticket-row"><span className="k">Recurrence</span><span className="v">{recurrenceLabel}</span></div>
          <div className="ticket-row"><span className="k">Price per visit</span><span className="v mono">{money(booking.price)}</span></div>
          {nextDate && (
            <div className="ticket-row"><span className="k">Next visit (est.)</span><span className="v">{formatDateLabel(nextDate)}</span></div>
          )}
        </div>
      </div>
    </div>
  );
}
