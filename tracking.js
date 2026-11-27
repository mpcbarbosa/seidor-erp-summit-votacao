// Landing page de seguimento — ERP Summit Porto 2026 · Seidor
// Regista aberturas, tempo ativo, secções vistas, cliques e pedidos de contacto por destinatário.
const crypto = require("crypto");

const ADMIN_KEY = process.env.ADMIN_KEY || "seidor";
const NOTIFY_TO = process.env.NOTIFY_TO || "";
const NOTIFY_FROM = process.env.NOTIFY_FROM || "Seidor · ERP Summit <avisos@mail.miguelbarbosapro.com>";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const ORIGINS = (process.env.LANDING_ORIGIN || "*").split(",").map((s) => s.trim());

// destinatários: {token: {n, pn, e, emp, g, pres}} — vem do ambiente, nunca do repositório
let R = {};
try { R = JSON.parse(process.env.RECIPIENTS || "{}"); } catch (e) { console.error("RECIPIENTS inválido"); }

let pool = null;
const mem = { visits: new Map(), events: [] };

async function init() {
  if (!process.env.DATABASE_URL) { console.log("tracking: sem DATABASE_URL, a usar memória"); return; }
  const { Pool } = require("pg");
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : false, max: 4 });
  await pool.query(`
    create table if not exists visits (
      sid text primary key, token text, started timestamptz default now(), last_seen timestamptz default now(),
      active_sec int default 0, max_scroll int default 0, ua text, ref text);
    create table if not exists events (
      id bigserial primary key, sid text, token text, type text, data text, at timestamptz default now());
    create index if not exists events_token on events(token);
    create table if not exists contacts (token text primary key, at timestamptz default now(), notified boolean default false);
  `);
  console.log("tracking: postgres pronto");
}

function cors(req) {
  const o = req.headers.origin || "";
  const allow = ORIGINS.includes("*") ? "*" : ORIGINS.includes(o) ? o : ORIGINS[0];
  return { "Access-Control-Allow-Origin": allow, "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" };
}
function json(res, code, obj, extra = {}) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((ok) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > 8000) req.destroy(); });
    req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { ok({}); } });
  });
}
const clean = (v, n = 200) => String(v ?? "").slice(0, n);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

async function record(ev, req) {
  const t = R[ev.t] ? ev.t : (ev.t ? "desconhecido:" + clean(ev.t, 40) : "sem-token");
  const sid = /^[a-z0-9]{8,40}$/i.test(ev.sid || "") ? ev.sid : crypto.randomBytes(8).toString("hex");
  const type = clean(ev.type, 30), data = clean(ev.data, 300);
  const sec = Math.max(0, Math.min(36000, parseInt(ev.sec, 10) || 0));
  const scroll = Math.max(0, Math.min(100, parseInt(ev.scroll, 10) || 0));
  if (pool) {
    await pool.query(
      `insert into visits(sid, token, ua, ref) values($1,$2,$3,$4)
       on conflict (sid) do update set last_seen = now(), active_sec = greatest(visits.active_sec, $5), max_scroll = greatest(visits.max_scroll, $6)`,
      [sid, t, clean(req.headers["user-agent"], 300), clean(ev.ref, 300), sec, scroll]);
    if (type !== "ping") await pool.query("insert into events(sid, token, type, data) values($1,$2,$3,$4)", [sid, t, type, data]);
  } else {
    const v = mem.visits.get(sid) || { sid, token: t, started: new Date(), active_sec: 0, max_scroll: 0 };
    v.last_seen = new Date(); v.active_sec = Math.max(v.active_sec, sec); v.max_scroll = Math.max(v.max_scroll, scroll);
    mem.visits.set(sid, v);
    if (type !== "ping") mem.events.push({ sid, token: t, type, data, at: new Date() });
  }
  return { t, type };
}

async function notifyContact(t) {
  const p = R[t];
  if (!p) return;
  if (pool) {
    const r = await pool.query("insert into contacts(token) values($1) on conflict do nothing returning token", [t]);
    if (!r.rowCount) return; // já avisado
  }
  if (!RESEND_API_KEY || !NOTIFY_TO) { console.log("pedido de contacto (sem aviso por email):", p.n, p.emp); return; }
  const subject = `Pedido de contacto: ${p.n} (${p.emp})`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#07153A">
    <p><b>${esc(p.n)}</b> da <b>${esc(p.emp)}</b> carregou no botão «Pedido de Contacto» na página da ERP Summit Session.</p>
    <table style="border-collapse:collapse;font-size:14px">
      <tr><td style="padding:4px 12px 4px 0;color:#4a5878">Email</td><td>${esc(p.e)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#4a5878">Cargo</td><td>${esc(p.cargo || "")}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#4a5878">Grupo</td><td>${esc(p.g)} · ${esc(p.pres)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#4a5878">Quando</td><td>${new Date().toLocaleString("pt-PT", { timeZone: "Europe/Lisbon" })}</td></tr>
    </table></div>`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: NOTIFY_FROM, to: NOTIFY_TO.split(","), reply_to: p.e, subject, html }),
    });
    if (!r.ok) console.error("resend", r.status, await r.text());
    else if (pool) await pool.query("update contacts set notified = true where token = $1", [t]);
  } catch (e) { console.error("resend", e.message); }
}

async function summary() {
  let visits, events, contacts;
  if (pool) {
    visits = (await pool.query("select * from visits")).rows;
    events = (await pool.query("select * from events order by at")).rows;
    contacts = (await pool.query("select * from contacts")).rows;
  } else { visits = [...mem.visits.values()]; events = mem.events; contacts = events.filter((e) => e.type === "contact").map((e) => ({ token: e.token, at: e.at })); }
  const rows = Object.entries(R).map(([t, p]) => {
    const vs = visits.filter((v) => v.token === t), ev = events.filter((e) => e.token === t);
    const c = contacts.find((x) => x.token === t);
    const first = vs.length ? new Date(Math.min(...vs.map((v) => +new Date(v.started)))) : null;
    const last = vs.length ? new Date(Math.max(...vs.map((v) => +new Date(v.last_seen)))) : null;
    const secs = [...new Set(ev.filter((e) => e.type === "section").map((e) => e.data))];
    const clicks = ev.filter((e) => e.type === "click").map((e) => e.data);
    return { t, ...p, visitas: vs.length, primeira: first, ultima: last, tempo: vs.reduce((a, v) => a + (v.active_sec || 0), 0),
      scroll: vs.reduce((a, v) => Math.max(a, v.max_scroll || 0), 0), seccoes: secs, cliques: clicks, contacto: c ? new Date(c.at) : null };
  });
  const outros = visits.filter((v) => !R[v.token]).length;
  return { rows, outros };
}
const fmt = (d) => (d ? d.toLocaleString("pt-PT", { timeZone: "Europe/Lisbon", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
const dur = (s) => (s ? (s >= 60 ? Math.floor(s / 60) + " min " + (s % 60) + " s" : s + " s") : "");

async function painel(res, url) {
  const { rows, outros } = await summary();
  rows.sort((a, b) => (b.contacto ? 1 : 0) - (a.contacto ? 1 : 0) || (b.ultima || 0) - (a.ultima || 0) || a.g.localeCompare(b.g));
  const abriram = rows.filter((r) => r.visitas).length, pedidos = rows.filter((r) => r.contacto).length;
  const k = encodeURIComponent(url.searchParams.get("key"));
  const tr = rows.map((r) => `<tr class="${r.contacto ? "hot" : r.visitas ? "" : "mute"}">
    <td>${esc(r.g)}</td><td><b>${esc(r.n)}</b><br><span>${esc(r.emp)}</span></td><td>${esc(r.pres)}</td>
    <td>${r.visitas || ""}</td><td>${fmt(r.primeira)}</td><td>${fmt(r.ultima)}</td><td>${dur(r.tempo)}</td><td>${r.scroll ? r.scroll + "%" : ""}</td>
    <td>${esc(r.seccoes.join(", "))}</td><td>${esc([...new Set(r.cliques)].join(", "))}</td><td>${r.contacto ? "<b>" + fmt(r.contacto) + "</b>" : ""}</td></tr>`).join("");
  const html = `<!doctype html><html lang="pt-PT"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Acompanhamento · ERP Summit Porto</title>
  <meta http-equiv="refresh" content="60"><style>
  body{font:14px/1.4 Arial,sans-serif;color:#07153A;margin:24px}h1{font-size:22px;margin:0 0 4px}p{color:#4a5878;margin:0 0 16px}
  .k{display:flex;gap:28px;margin:12px 0 18px}.k b{display:block;font-size:30px}table{border-collapse:collapse;width:100%}
  th{background:#07153A;color:#fff;text-align:left;padding:8px;font-weight:600;position:sticky;top:0}td{padding:7px 8px;border-bottom:1px solid #dfe5ef;vertical-align:top}
  td span{color:#4a5878;font-size:12px}tr.hot td{background:#e6f4ea}tr.mute td{color:#9aa5bd}a{color:#1D5CFF}</style></head><body>
  <h1>Acompanhamento da página «Quanto custa uma notícia?»</h1><p>Atualiza a cada minuto · <a href="/painel.csv?key=${k}">Exportar CSV</a></p>
  <div class="k"><div><b>${rows.length}</b>destinatários</div><div><b>${abriram}</b>abriram a página</div><div><b>${pedidos}</b>pedidos de contacto</div><div><b>${outros}</b>visitas sem link pessoal</div></div>
  <table><tr><th>Grupo</th><th>Pessoa</th><th>No evento</th><th>Visitas</th><th>1.ª abertura</th><th>Última</th><th>Tempo ativo</th><th>Leitura</th><th>Secções vistas</th><th>Cliques</th><th>Pedido de contacto</th></tr>${tr}</table></body></html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(html);
}
async function csv(res) {
  const { rows } = await summary();
  const q = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const head = ["Grupo", "Nome", "Empresa", "Email", "No evento", "Visitas", "Primeira abertura", "Última", "Tempo ativo (s)", "Leitura (%)", "Secções vistas", "Cliques", "Pedido de contacto"];
  const lines = rows.map((r) => [r.g, r.n, r.emp, r.e, r.pres, r.visitas, fmt(r.primeira), fmt(r.ultima), r.tempo, r.scroll, r.seccoes.join(" | "), r.cliques.join(" | "), fmt(r.contacto)].map(q).join(";"));
  res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="acompanhamento-erp-summit.csv"' });
  res.end("﻿" + [head.map(q).join(";"), ...lines].join("\r\n"));
}

async function handle(req, res, p, url) {
  if (p.startsWith("/api/t/") || p === "/api/t") {
    const h = cors(req);
    if (req.method === "OPTIONS") { res.writeHead(204, h); res.end(); return true; }
    if (req.method === "GET" && p === "/api/t/hello") {
      const r = R[url.searchParams.get("t")];
      json(res, 200, r ? { pn: r.pn, emp: r.emp, sal: r.sal } : {}, h); return true;
    }
    if (req.method === "POST" && p === "/api/t") {
      const ev = await body(req);
      const { t, type } = await record(ev, req);
      if (type === "contact") await notifyContact(t);
      json(res, 200, { ok: true }, h); return true;
    }
  }
  if (p === "/painel" || p === "/painel.csv") {
    if (url.searchParams.get("key") !== ADMIN_KEY) { json(res, 403, { error: "chave inválida" }); return true; }
    if (p === "/painel") await painel(res, url); else await csv(res);
    return true;
  }
  return false;
}

module.exports = { init, handle };
