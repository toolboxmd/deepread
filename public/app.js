// Deep Read prototype client: streams chunks as the reader approaches the end,
// caps downward scrolling at a fast reading pace, and switches design variants.
const VARIANTS = { A: "Book", B: "Night", C: "Margin" };
const $ = (id) => document.getElementById(id);
const article = $("article");

const state = { id: null, maxWpm: 700, chunks: [], writing: false, waiting: false, retryTimer: 0, cost: 0, cached: 0, prompt: 0 };

// ---------- variants ----------
function setVariant(key, push = true) {
  if (!VARIANTS[key]) key = "A";
  document.body.dataset.variant = key;
  $("variant-name").textContent = `${key} (${VARIANTS[key]})`;
  if (push) {
    const url = new URL(location.href);
    url.searchParams.set("variant", key);
    history.replaceState(null, "", url);
  }
}
function cycle(step) {
  const keys = Object.keys(VARIANTS);
  const i = keys.indexOf(document.body.dataset.variant);
  setVariant(keys[(i + step + keys.length) % keys.length]);
}
$("prev").onclick = () => cycle(-1);
$("next").onclick = () => cycle(1);
addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, [contenteditable]")) return;
  if (e.key === "ArrowLeft") cycle(-1);
  if (e.key === "ArrowRight") cycle(1);
});
setVariant(new URLSearchParams(location.search).get("variant") || "A", false);

// ---------- rendering ----------
// Math is pulled out before Markdown so marked cannot eat the backslashes.
function render(src) {
  const math = [];
  src = src.replace(/\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g, (_, display, inline) => {
    math.push(katex.renderToString(display ?? inline, { displayMode: display != null, throwOnError: false }));
    return `@@MATH${math.length - 1}@@`;
  });
  return marked.parse(src).replace(/@@MATH(\d+)@@/g, (_, n) => math[n]);
}

let frame = 0;
function scheduleRender() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    article.innerHTML = render(state.chunks.join("\n\n"));
    buildOutline();
    checkAhead();
  });
}

function buildOutline() {
  const heads = [...article.querySelectorAll("h1, h2")];
  $("outline").innerHTML = heads.map((h, i) => {
    h.id = `s${i}`;
    return `<li class="${h.tagName === "H1" ? "top" : ""}"><a href="#s${i}">${h.textContent}</a></li>`;
  }).join("");
}

function status(text) { $("status").textContent = text; }

function stats() {
  const words = state.chunks.join(" ").split(/\s+/).filter(Boolean).length;
  $("stats").textContent = state.id
    ? `${state.chunks.length} chunks · ${words} words · $${state.cost.toFixed(3)} · cached ${state.cached}/${state.prompt} tok · cap ${state.maxWpm} wpm`
    : "";
}

// ---------- generation ----------
async function startArticle(topic) {
  document.body.dataset.view = "reader";
  article.innerHTML = "";
  clearTimeout(state.retryTimer);
  Object.assign(state, { id: null, chunks: [], writing: false, waiting: false, cost: 0, cached: 0, prompt: 0 });
  status("Thinking about where to begin…");
  const r = await fetch("/api/article", { method: "POST", body: JSON.stringify({ topic }) });
  const info = await r.json();
  if (!r.ok) return status(info.error || "Could not start.");
  state.id = info.id;
  state.maxWpm = info.maxWpm;
  document.title = `${topic} · Deep Read`;
  readLimit = 0;
  fetchNext();
}

async function fetchNext() {
  if (state.writing || !state.id) return;
  state.writing = true;
  const index = state.chunks.length;
  state.chunks.push("");
  let finished = false;
  try {
    const r = await fetch(`/api/next?id=${state.id}`, { method: "POST" });
    if (r.status === 429) {
      const { retryAfterMs } = await r.json();
      state.chunks.pop();
      status("Keeping pace with your reading…");
      state.waiting = true;
      state.retryTimer = setTimeout(() => { state.waiting = false; checkAhead(); }, retryAfterMs + 50);
      return;
    }
    if (!r.ok) throw new Error((await r.json()).error);
    if (index > 0) status("");
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let cut;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const event = block.match(/^event: (.*)$/m)?.[1];
        const data = JSON.parse(block.match(/^data: (.*)$/m)?.[1] || "{}");
        if (event === "delta") { state.chunks[index] += data.text; status(""); scheduleRender(); }
        if (event === "done") {
          finished = true;
          state.cost = data.total; state.cached = data.cached; state.prompt = data.prompt;
        }
        if (event === "error") throw new Error(data.message);
      }
    }
    if (!finished) throw new Error("The stream ended early.");
  } catch (err) {
    if (!state.chunks[index]) state.chunks.pop();
    status(`Something went wrong: ${err.message}`);
  } finally {
    state.writing = false;
    stats();
    scheduleRender();
  }
}

// Keep about one screen of unread text below the viewport.
function checkAhead() {
  if (state.writing || state.waiting || !state.id || document.body.dataset.view !== "reader") return;
  const remaining = document.documentElement.scrollHeight - (scrollY + innerHeight);
  if (remaining < innerHeight * 1.2) fetchNext();
}

// ---------- reading-pace scroll cap ----------
// The furthest point you may scroll to grows at maxWpm, and you can bank at most one screen.
let readLimit = 0, lastTick = performance.now(), paceTimer = 0;
function pxPerSecond() {
  const words = Math.max(1, article.textContent.split(/\s+/).length);
  return (article.scrollHeight / words) * (state.maxWpm / 60);
}
function tick(now) {
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  if (document.body.dataset.view === "reader" && state.id) {
    // Grows at reading pace up to one screen past the viewport; never shrinks, so
    // re-reading earlier text is free.
    readLimit = Math.max(readLimit, Math.min(readLimit + pxPerSecond() * dt, scrollY + innerHeight));
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
addEventListener("scroll", () => {
  if (document.body.dataset.view !== "reader") return;
  if (scrollY > readLimit + 2) {
    scrollTo(0, readLimit);
    $("pace").hidden = false;
    clearTimeout(paceTimer);
    paceTimer = setTimeout(() => ($("pace").hidden = true), 900);
  }
  const max = document.documentElement.scrollHeight - innerHeight;
  $("progress-bar").style.width = `${max > 0 ? (scrollY / max) * 100 : 0}%`;
  checkAhead();
}, { passive: true });

// Jumping via the outline goes to text that already exists, so it lifts the cap.
$("outline").addEventListener("click", (e) => {
  const link = e.target.closest("a");
  if (!link) return;
  const target = document.querySelector(link.getAttribute("href"));
  if (target) readLimit = Math.max(readLimit, target.getBoundingClientRect().top + scrollY);
});

$("search-form").onsubmit = (e) => {
  e.preventDefault();
  const topic = $("topic").value.trim();
  if (topic) startArticle(topic);
};
stats();
