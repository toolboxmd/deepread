// Deep Read local prototype server. No dependencies; Node 22+.
// Holds the OpenRouter key and each article's conversation, streams chunks to the page,
// and refuses chunks faster than a fast reader could read them.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join, normalize } from "node:path";

const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.DEEPREAD_MODEL || "x-ai/grok-4.7";
const EFFORT = process.env.DEEPREAD_EFFORT || "medium";
const PORT = Number(process.env.PORT || 4317);
const MAX_WPM = Number(process.env.DEEPREAD_MAX_WPM || 700); // fast reading speed
const BURST_WORDS = 900; // lets the first ~2 screens generate back to back
const MAX_CHUNKS = 80;
const SYSTEM = await readFile(new URL("./prompt.md", import.meta.url), "utf8");
const PUBLIC = new URL("./public/", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

if (!KEY) throw new Error("OPENROUTER_API_KEY is not set; start with ./dev");

const sessions = new Map(); // id -> { topic, messages, busy, budget, at, cost, chunks }
const CC = { type: "ephemeral" };

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// Reading budget in words: refills at MAX_WPM, a chunk spends its word count.
function refill(s) {
  const now = Date.now();
  s.budget = Math.min(BURST_WORDS, s.budget + ((now - s.at) / 60000) * MAX_WPM);
  s.at = now;
}

async function start(req, res) {
  let body = "";
  for await (const part of req) body += part;
  const topic = String(JSON.parse(body || "{}").topic || "").trim().slice(0, 200);
  if (!topic) return json(res, 400, { error: "empty topic" });
  const id = randomUUID();
  sessions.set(id, {
    topic, busy: false, budget: BURST_WORDS, at: Date.now(), cost: 0, chunks: 0,
    messages: [{ role: "system", content: [{ type: "text", text: SYSTEM, cache_control: CC }] }],
  });
  json(res, 200, { id, model: MODEL, effort: EFFORT, maxWpm: MAX_WPM });
}

async function next(req, res, id) {
  const s = sessions.get(id);
  if (!s) return json(res, 404, { error: "unknown article" });
  if (s.busy) return json(res, 409, { error: "already writing" });
  if (s.chunks >= MAX_CHUNKS) return json(res, 410, { error: "article limit reached" });
  refill(s);
  if (s.budget < 0) return json(res, 429, { retryAfterMs: Math.ceil((-s.budget / MAX_WPM) * 60000) });

  s.busy = true;
  // One moving cache breakpoint on the newest user turn, plus the system prompt.
  for (const m of s.messages.slice(1)) if (m.role === "user" && Array.isArray(m.content)) m.content = m.content[0].text;
  const turn = { role: "user", content: [{ type: "text", text: s.chunks === 0 ? s.topic : "continue", cache_control: CC }] };
  const upstream = new AbortController();
  res.on("close", () => upstream.abort());
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let text = "", usage = null;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", signal: upstream.signal,
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json",
        "user-agent": "deepread-prototype/0.1", "x-title": "Deep Read prototype" },
      body: JSON.stringify({ model: MODEL, messages: [...s.messages, turn], stream: true,
        reasoning: { effort: EFFORT }, usage: { include: true }, session_id: id }),
    });
    if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const decoder = new TextDecoder();
    let buf = "";
    for await (const bytes of r.body) {
      buf += decoder.decode(bytes, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        const evt = JSON.parse(line.slice(6));
        if (evt.error) throw new Error(evt.error.message || "stream error");
        const delta = evt.choices?.[0]?.delta?.content;
        if (delta) { text += delta; send("delta", { text: delta }); }
        if (evt.usage) usage = evt.usage;
      }
    }
    s.messages.push(turn, { role: "assistant", content: text });
    s.chunks += 1;
    s.cost += usage?.cost || 0;
    const words = text.split(/\s+/).filter(Boolean).length;
    refill(s);
    s.budget -= words;
    send("done", { chunk: s.chunks, words, cost: usage?.cost || 0, total: s.cost,
      cached: usage?.prompt_tokens_details?.cached_tokens || 0, prompt: usage?.prompt_tokens || 0 });
    console.log(`[${id.slice(0, 8)}] chunk ${s.chunks} ${words}w $${(usage?.cost || 0).toFixed(4)} total $${s.cost.toFixed(4)}`);
  } catch (err) {
    if (!upstream.signal.aborted) { console.error(err); send("error", { message: String(err.message || err) }); }
  } finally {
    s.busy = false;
    res.end();
  }
}

async function serveStatic(res, path) {
  const file = normalize(join(PUBLIC, path === "/" ? "index.html" : path));
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: "forbidden" });
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch { json(res, 404, { error: "not found" }); }
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "POST" && url.pathname === "/api/article") return start(req, res).catch((e) => json(res, 400, { error: String(e) }));
  if (req.method === "POST" && url.pathname === "/api/next") return next(req, res, url.searchParams.get("id"));
  if (req.method === "GET") return serveStatic(res, url.pathname);
  json(res, 405, { error: "method not allowed" });
}).listen(PORT, "127.0.0.1", () => console.log(`Deep Read on http://localhost:${PORT}  (${MODEL}, ${EFFORT}, ${MAX_WPM} wpm cap)`));
