// Deep Read client: asks for screen-sized chunks only as the reader approaches the end,
// caps downward scrolling at a fast reading pace, and remembers the colour theme.
const $ = (id) => document.getElementById(id);
const article = $("article");
const DEBUG = new URLSearchParams(location.search).has("debug");

// Cost tuning. Waste when a reader stops is at most AHEAD + CHUNK screens of unread text;
// smaller chunks waste less but pay the model's fixed per-request thinking more often.
const CHUNK_SCREENS = 1.5; // each request asks for about this many screens of text
const AHEAD_SCREENS = 1.0; // request the next chunk when less than this much is unread
const MIN_WORDS = 150, MAX_WORDS = 600;

const MAX_WPM = 700; // fastest reading pace the scroll cap allows
const state = { id: null, topic: "", chunks: [], askedPer: [], writing: false, stopped: false, retryAt: 0, cost: 0, cached: 0, prompt: 0, asked: 0 };

// ---------- theme ----------
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("deepread-theme", theme);
}
document.querySelectorAll("[data-theme-choice]").forEach((b) => (b.onclick = () => setTheme(b.dataset.themeChoice)));

// ---------- text size ----------
const SIZES = [16, 18, 20, 22, 24, 26];
function stepSize(step) {
  const current = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--reader-size")) || 20;
  const i = SIZES.reduce((best, s, k) => (Math.abs(s - current) < Math.abs(SIZES[best] - current) ? k : best), 0);
  const next = SIZES[Math.min(SIZES.length - 1, Math.max(0, i + step))];
  document.documentElement.style.setProperty("--reader-size", `${next}px`);
  localStorage.setItem("deepread-size", next);
}
document.querySelectorAll("[data-size]").forEach((b) => (b.onclick = () => stepSize(Number(b.dataset.size))));

// ---------- settings dial: click or tap toggles; hover opens on devices that can hover ----------
const dial = $("dial");
let dialTimer = 0, openedAt = 0;
function setDial(open) {
  clearTimeout(dialTimer);
  if (open && !dial.classList.contains("open")) openedAt = performance.now();
  dial.classList.toggle("open", open);
  $("dial-toggle").setAttribute("aria-expanded", String(open));
}
// A click that lands just after hover opened the dial should not immediately close it.
$("dial-toggle").onclick = () => {
  const open = dial.classList.contains("open");
  setDial(!open || performance.now() - openedAt < 600);
};
if (matchMedia("(hover: hover)").matches) {
  dial.addEventListener("mouseenter", () => setDial(true));
  dial.addEventListener("mouseleave", () => { dialTimer = setTimeout(() => setDial(false), 350); });
}
addEventListener("keydown", (e) => { if (e.key === "Escape") setDial(false); });
addEventListener("pointerdown", (e) => { if (!dial.contains(e.target)) setDial(false); });

// ---------- measuring ----------
function textWords() { return article.textContent.split(/\s+/).filter(Boolean).length; }
function textHeight() {
  const first = article.firstElementChild, last = article.lastElementChild;
  return first ? last.getBoundingClientRect().bottom - first.getBoundingClientRect().top : 0;
}
// Pixels per word, measured from the article once there is enough text, estimated from
// the column width and font size before that.
function pxPerWord() {
  const words = textWords();
  if (words > 120) return textHeight() / words;
  const cs = getComputedStyle(article);
  const size = parseFloat(cs.fontSize), line = parseFloat(cs.lineHeight) || size * 1.72;
  const width = article.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  if (!(width > 0)) return 4.6;
  return (line / (width / (size * 2.9))) * 1.25; // 1.25 covers headings and paragraph gaps
}
// The first request fills the visible screen plus the read-ahead buffer (and the title)
// in one go; later requests add CHUNK_SCREENS.
function wordsForChunk() {
  const screens = state.chunks.length === 0 ? 1 + AHEAD_SCREENS + 0.2 : CHUNK_SCREENS;
  return Math.round(Math.min(MAX_WORDS, Math.max(MIN_WORDS, (screens * innerHeight) / pxPerWord())));
}
function unreadPx() {
  const last = article.lastElementChild;
  return last ? last.getBoundingClientRect().bottom - innerHeight : 0;
}

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
    checkAhead();
  });
}

function status(text) { $("status").textContent = text; }

function stats() {
  $("stats").hidden = !DEBUG || !state.id;
  const words = state.chunks.join(" ").split(/\s+/).filter(Boolean).length;
  $("stats").textContent = `${state.chunks.length} chunks · ${words} words · last ask ${state.asked}w · `
    + `$${state.cost.toFixed(4)} · cached ${state.cached}/${state.prompt} tok · ${pxPerWord().toFixed(1)} px/word`;
}

// ---------- generation ----------
// The page keeps the article; each request sends it back so the server stays stateless.
function startArticle(topic) {
  document.body.dataset.view = "reader";
  article.innerHTML = "";
  Object.assign(state, { id: crypto.randomUUID(), topic, chunks: [], askedPer: [], writing: false, stopped: false, retryAt: 0,
    cost: 0, cached: 0, prompt: 0, asked: 0 });
  status("Thinking about where to begin…");
  document.title = `${topic} · Deep Read`;
  readLimit = 0;
  fetchNext();
}

async function fetchNext() {
  if (state.writing || state.stopped || !state.id) return;
  state.writing = true;
  state.asked = wordsForChunk();
  const turns = state.chunks.map((text, i) => ({ text, asked: state.askedPer[i] }));
  const index = state.chunks.length;
  state.chunks.push("");
  let finished = false;
  try {
    const r = await fetch("/api/next", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: state.id, topic: state.topic, turns, words: state.asked }) });
    if (r.status === 402) {
      state.stopped = true;
      throw new Error("Deep Read is out of reading credit for now. Please come back later.");
    }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "The writer is unavailable right now.");
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
          state.askedPer[index] = data.asked;
          state.cost += data.cost; state.cached = data.cached; state.prompt = data.prompt;
        }
        if (event === "error") throw new Error(data.message);
      }
    }
    if (!finished) throw new Error("The stream ended early.");
  } catch (err) {
    // A chunk only counts once it finished; a partial one would break the shared history.
    if (!finished) state.chunks.splice(index, 1);
    if (state.stopped) status(err.message);
    else { status(`Something went wrong: ${err.message} Trying again shortly.`); state.retryAt = Date.now() + 10000; setTimeout(checkAhead, 10050); }
  } finally {
    state.writing = false;
    stats();
    scheduleRender();
  }
}

// Ask for more only when less than AHEAD_SCREENS of written text is left below the viewport.
function checkAhead() {
  if (state.writing || state.stopped || Date.now() < state.retryAt || !state.id || document.body.dataset.view !== "reader") return;
  if (unreadPx() < innerHeight * AHEAD_SCREENS) fetchNext();
}

// ---------- reading-pace scroll cap ----------
// The furthest point you may scroll to grows at MAX_WPM, and you can bank at most one screen.
let readLimit = 0, lastTick = performance.now(), paceTimer = 0;
function tick(now) {
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  if (document.body.dataset.view === "reader" && state.id) {
    const pxPerSecond = pxPerWord() * (MAX_WPM / 60);
    // Grows at reading pace up to one screen past the viewport; never shrinks, so
    // re-reading earlier text is free.
    readLimit = Math.max(readLimit, Math.min(readLimit + pxPerSecond * dt, scrollY + innerHeight));
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

$("search-form").onsubmit = (e) => {
  e.preventDefault();
  const topic = $("topic").value.trim();
  if (topic) startArticle(topic);
};
