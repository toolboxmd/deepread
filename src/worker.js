// Deep Read Cloudflare Worker. Stateless: the page keeps the article and sends it back
// with each request; the Worker adds the key, the fixed prompt and model, and streams the
// next chunk. Spending is bounded by the OpenRouter key's own limit, not by this code.
import SYSTEM from "../prompt.md";

const MODEL = "x-ai/grok-4.7";
const EFFORT = "medium";
const MAX_TURNS = 80;
const MAX_CHUNK_CHARS = 8000;
const CC = { type: "ephemeral" };

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const clampWords = (n) => Math.min(700, Math.max(120, Math.round(Number(n) || 400)));

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/next") {
      if (request.method !== "POST") return json(405, { error: "method not allowed" });
      return next(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
};

async function next(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch { return json(400, { error: "invalid request" }); }
  const topic = String(body.topic || "").trim().slice(0, 200);
  const turns = Array.isArray(body.turns) ? body.turns : [];
  const id = String(body.id || "").slice(0, 64);
  if (!topic || turns.length >= MAX_TURNS) return json(400, { error: "invalid request" });
  if (turns.some((t) => typeof t?.text !== "string" || t.text.length > MAX_CHUNK_CHARS)) return json(400, { error: "invalid request" });

  // Rebuild the exact same history each time so the cached prefix keeps matching.
  const ask = (i, words) => (i === 0 ? `${topic}\n\n(Start the article. About ${words} words.)` : `continue (about ${words} words)`);
  const messages = [{ role: "system", content: [{ type: "text", text: SYSTEM, cache_control: CC }] }];
  turns.forEach((t, i) => messages.push({ role: "user", content: ask(i, clampWords(t.asked)) }, { role: "assistant", content: t.text }));
  const words = clampWords(body.words);
  messages.push({ role: "user", content: [{ type: "text", text: ask(turns.length, words), cache_control: CC }] });

  const upstream = new AbortController();
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST", signal: upstream.signal,
    headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "content-type": "application/json",
      "http-referer": "https://deepread.toolbox.md", "x-title": "Deep Read" },
    body: JSON.stringify({ model: MODEL, messages, stream: true, reasoning: { effort: EFFORT },
      usage: { include: true }, session_id: id || undefined }),
  });
  if (r.status === 402) return json(402, { error: "out_of_credit" });
  if (!r.ok) {
    console.log(JSON.stringify({ evt: "upstream_error", status: r.status, body: (await r.text()).slice(0, 300) }));
    return json(502, { error: "The writer is unavailable right now." });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (event, data) => writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  ctx.waitUntil((async () => {
    let text = "", usage = null, buf = "";
    const decoder = new TextDecoder();
    try {
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
          if (delta) { text += delta; await send("delta", { text: delta }); }
          if (evt.usage) usage = evt.usage;
        }
      }
      const written = text.split(/\s+/).filter(Boolean).length;
      await send("done", { asked: words, words: written, cost: usage?.cost || 0,
        cached: usage?.prompt_tokens_details?.cached_tokens || 0, prompt: usage?.prompt_tokens || 0 });
      // One non-personal line per chunk: how far readers get and what it costs.
      console.log(JSON.stringify({ evt: "chunk", article: id, n: turns.length + 1, asked: words, written,
        cost: usage?.cost || 0, cached: usage?.prompt_tokens_details?.cached_tokens || 0, prompt: usage?.prompt_tokens || 0 }));
      await writer.close();
    } catch (err) {
      upstream.abort(); // reader left, or the stream failed
      try { await send("error", { message: "The writer stopped unexpectedly." }); await writer.close(); } catch {}
      console.log(JSON.stringify({ evt: "chunk_aborted", article: id, n: turns.length + 1, reason: String(err?.message || err).slice(0, 200) }));
    }
  })());

  return new Response(readable, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
