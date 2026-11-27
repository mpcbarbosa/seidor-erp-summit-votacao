// Votação ao vivo — ERP Summit Session Porto 2026 · Seidor
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "seidor";
const N = 4;

// ---------- storage: Redis (Render Key Value) if available, else memory ----------
let redis = null;
const mem = { counts: new Array(N).fill(0), voters: new Set() };
async function initStore() {
  if (!process.env.REDIS_URL) return;
  try {
    const { createClient } = require("redis");
    redis = createClient({ url: process.env.REDIS_URL });
    redis.on("error", (e) => console.error("redis", e.message));
    await redis.connect();
    console.log("redis ligado");
  } catch (e) { console.error("sem redis, a usar memória:", e.message); redis = null; }
}
async function vote(o, vid) {
  if (redis) {
    const fresh = await redis.sAdd("poll:voters", vid);
    if (!fresh) return false;
    await redis.hIncrBy("poll:counts", String(o), 1);
    return true;
  }
  if (mem.voters.has(vid)) return false;
  mem.voters.add(vid); mem.counts[o]++; return true;
}
async function results() {
  if (redis) {
    const h = await redis.hGetAll("poll:counts");
    const counts = Array.from({ length: N }, (_, i) => parseInt(h[String(i)] || "0", 10));
    return { counts, total: counts.reduce((a, b) => a + b, 0) };
  }
  return { counts: [...mem.counts], total: mem.counts.reduce((a, b) => a + b, 0) };
}
async function reset() {
  if (redis) { await redis.del("poll:counts"); await redis.del("poll:voters"); }
  mem.counts = new Array(N).fill(0); mem.voters = new Set();
}

// ---------- http ----------
const PUB = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
function send(res, code, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
  res.end(body);
}
function file(res, name) {
  fs.readFile(path.join(PUB, name), (err, data) => {
    if (err) return send(res, 404, "not found", "text/plain");
    send(res, 200, data, TYPES[path.extname(name)] || "application/octet-stream", { "Cache-Control": "public, max-age=300" });
  });
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]));
}
function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${req.headers.host}`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    if (req.method === "GET" && (p === "/" || p === "/votar")) return file(res, "vote.html");
    if (req.method === "GET" && p === "/resultados") return file(res, "results.html");
    if (req.method === "GET" && p === "/assets.js") return file(res, "assets.js");
    if (req.method === "GET" && p === "/healthz") return send(res, 200, '{"ok":true}');
    if (req.method === "GET" && p === "/qr.svg") {
      const svg = await QRCode.toString(baseUrl(req) + "/", { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#07153A", light: "#FFFFFF" } });
      return send(res, 200, svg, "image/svg+xml", { "Cache-Control": "public, max-age=300" });
    }
    if (req.method === "GET" && p === "/api/info") return send(res, 200, JSON.stringify({ url: baseUrl(req).replace(/^https?:\/\//, "") }));
    if (req.method === "GET" && p === "/api/results") return send(res, 200, JSON.stringify(await results()));
    if (p === "/api/reset") {
      if (url.searchParams.get("key") !== ADMIN_KEY) return send(res, 403, '{"error":"chave inválida"}');
      await reset();
      return send(res, 200, '{"ok":true,"msg":"Votação reposta a zero."}');
    }
    if (req.method === "POST" && p === "/api/vote") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 1000) req.destroy(); });
      req.on("end", async () => {
        let o;
        try { o = JSON.parse(body).o; } catch { return send(res, 400, '{"error":"pedido inválido"}'); }
        if (!Number.isInteger(o) || o < 0 || o >= N) return send(res, 400, '{"error":"opção inválida"}');
        let vid = cookies(req).vid;
        const extra = {};
        if (!vid || !/^[a-f0-9]{32}$/.test(vid)) {
          vid = crypto.randomBytes(16).toString("hex");
          extra["Set-Cookie"] = `vid=${vid}; Path=/; Max-Age=86400; SameSite=Lax; Secure; HttpOnly`;
        }
        const ok = await vote(o, vid);
        send(res, 200, JSON.stringify({ ok, already: !ok }), "application/json; charset=utf-8", extra);
      });
      return;
    }
    send(res, 404, "not found", "text/plain");
  } catch (e) {
    console.error(e);
    send(res, 500, '{"error":"erro interno"}');
  }
});

initStore().then(() => server.listen(PORT, () => console.log("a ouvir na porta " + PORT)));
