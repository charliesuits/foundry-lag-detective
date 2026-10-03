/**
 * Lag Detective — turning numbers into suspects.
 *
 *  - trends():   which counters climb steadily over the session (a leak), fitted with a straight line
 *  - suspects(): ranked findings from the trends, the current readings and the per-module blame
 *  - blame():    per-module table of main-thread time, hook time, intervals, listeners and errors
 *  - checkup():  a one-off audit of the machine, settings, scene and module list
 */
import { MODULE_ID, I, hookRegistrations, intervalsByOwner, listenersByOwner } from "./instrument.js";
import { S } from "./sampler.js";

const n = (f, d = null) => { try { const v = f(); return v === undefined || v === null || Number.isNaN(v) ? d : v; } catch { return d; } };
const fmt = (x, d = 0) => (x === null || x === undefined ? "—" : Number(x).toLocaleString(undefined, { maximumFractionDigits: d }));
const median = (a) => { const s = a.filter((x) => typeof x === "number").sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

export const FIELDS = {
  fps: { label: "Frames per second", unit: "fps", good: "high" },
  frameP95: { label: "Slow-frame time (95th percentile)", unit: "ms" },
  frameMax: { label: "Worst frame", unit: "ms" },
  hitches: { label: "Hitches over 100 ms", unit: "" },
  stallMax: { label: "Longest main-thread stall", unit: "ms" },
  longFrameMs: { label: "Time in long frames", unit: "ms" },
  heapMB: { label: "JavaScript memory", unit: "MB" },
  gpuTex: { label: "GPU textures (2D canvas)", unit: "" },
  gpuTexMB: { label: "GPU texture memory (2D canvas)", unit: "MB" },
  pixiCache: { label: "PIXI texture cache", unit: "" },
  stageObjects: { label: "Canvas display objects", unit: "" },
  tickerFns: { label: "Canvas ticker listeners", unit: "" },
  threeGeo: { label: "3D geometries", unit: "" },
  threeTex: { label: "3D textures", unit: "" },
  threeProg: { label: "3D shader programs", unit: "" },
  threeTris: { label: "3D triangles drawn", unit: "" },
  modelCache: { label: "3D model cache", unit: "" },
  videos: { label: "Video elements", unit: "" },
  videosPlaying: { label: "Videos playing", unit: "" },
  sounds: { label: "Sounds playing", unit: "" },
  canvases: { label: "Canvas elements", unit: "" },
  domNodes: { label: "Page elements (DOM)", unit: "" },
  sidebarNodes: { label: "Sidebar elements", unit: "" },
  chatNodes: { label: "Chat log elements", unit: "" },
  windows: { label: "Open windows", unit: "" },
  hooksRegistered: { label: "Registered hook callbacks", unit: "" },
  hookMs: { label: "Time inside hooks (per sample)", unit: "ms" },
  renders: { label: "Window renders", unit: "/min" },
  refreshes: { label: "Placeable refreshes", unit: "/min" },
  docUpdates: { label: "Document changes", unit: "/min" },
  intervals: { label: "Active repeating timers", unit: "" },
  listeners: { label: "Page-wide event listeners", unit: "" },
  seqEffects: { label: "Sequencer effects running", unit: "" },
  errors: { label: "Console errors", unit: "/min" },
  pingMs: { label: "Server round trip", unit: "ms" },
  latencyMs: { label: "Foundry latency average", unit: "ms" },
  sockIn: { label: "Socket messages in", unit: "/min" },
  sockOut: { label: "Socket messages out", unit: "/min" },
  sockInKB: { label: "Socket data in", unit: "KB/min" },
};

// ─────────────────────────────────────────────────────────────── trends
export function trend(field, rows = S.rows) {
  const pts = rows.filter((r) => !r.hidden && typeof r[field] === "number" && r.min >= 2);
  if (pts.length < 8) return null;
  const span = pts.at(-1).min - pts[0].min;
  if (span < 15) return null;
  const xs = pts.map((r) => r.min / 60), ys = pts.map((r) => r[field]);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  if (!sxx) return null;
  const slope = sxy / sxx;
  const r2 = syy ? (sxy * sxy) / (sxx * syy) : 0;
  const start = median(ys.slice(0, 3)), end = median(ys.slice(-3));
  return { field, slope, r2, start, end, span, points: pts.length };
}

/** Leak rules: a steady climb (per hour) that means something specific. */
const GROWTH = [
  { f: "heapMB", min: 60, high: 250, what: "JavaScript memory keeps climbing",
    why: "Something is holding on to data it no longer needs. Sequencer's video cache plateaus near 500 MB by design, so a climb that flattens there is not a leak.",
    next: "Check the Modules tab for a module whose hook registrations, timers or listeners also grow. Use Tools → A/B tests to see which one makes the memory drop." },
  { f: "gpuTexMB", min: 100, high: 500, what: "GPU texture memory keeps climbing",
    why: "Images or video frames are being loaded onto the graphics card and not released. Usual causes: animated tiles and tokens, effect videos, scene changes that leave textures behind.",
    next: "Tools → Free unused textures, then Tools → End all Sequencer effects. Whichever makes the number drop names the source." },
  { f: "gpuTex", min: 60, high: 300, what: "The number of GPU textures keeps climbing", why: "Textures are being created faster than they are destroyed.", next: "Same as GPU texture memory. Also check the Checkup tab's list of the largest images." },
  { f: "stageObjects", min: 2000, high: 10000, what: "Canvas objects keep piling up",
    why: "Things drawn on the map (effects, text, graphics) are being added and never removed.", next: "Redraw the scene (Tools → Redraw canvas). If it drops back, a module is leaving objects behind; check effect and animation modules first." },
  { f: "tickerFns", min: 5, high: 30, what: "Per-frame callbacks keep piling up",
    why: "Each one runs 60 times a second. A module adds one and never removes it, so every frame gets a little more expensive.", next: "Redraw the canvas and see if it resets. The Modules tab's interval and hook columns usually show the same module." },
  { f: "videos", min: 3, high: 15, what: "Video elements keep piling up",
    why: "Every <video> decodes frames. Animation modules (Sequencer, JB2A, Automated Animations) and animated tiles are the usual source.", next: "Tools → End all Sequencer effects. If videos drop, it's the effects; if not, look at animated tiles and tokens." },
  { f: "canvases", min: 2, high: 8, what: "Extra drawing surfaces keep being created",
    why: "Each <canvas> can hold its own graphics context. Dice, 3D previews and some sheets create them.", next: "Close all windows (Tools) and see if the count drops. Dice So Nice and 3D modules are the usual suspects." },
  { f: "domNodes", min: 4000, high: 20000, what: "The page keeps growing",
    why: "Every element on the page makes layout and style work more expensive. Windows left open, chat and the sidebar are the usual places.", next: "Look at which region grows: sidebar, chat or open windows (the Timeline tab has each). Tools → Close all windows." },
  { f: "sidebarNodes", min: 3000, high: 15000, what: "The sidebar keeps growing", why: "A sidebar tab keeps adding rows it never removes, or re-renders into a larger list.", next: "Switch sidebar tabs and watch whether it drops. Collapse big playlists and folders." },
  { f: "chatNodes", min: 3000, high: 15000, what: "The chat log keeps growing", why: "Every message stays on the page. Big roll cards and animated messages make it worse.", next: "Tools → Re-render chat. Consider exporting and flushing chat between sessions." },
  { f: "windows", min: 3, high: 10, what: "Windows are left open and piling up", why: "Hidden or minimised windows still re-render when their data changes.", next: "Tools → Close all windows." },
  { f: "hooksRegistered", min: 30, high: 200, blame: "hooks", what: "Hook callbacks keep being registered and never removed",
    why: "Every time the event fires, all of those callbacks run. This is a classic slow-down-over-time leak.", next: "The Modules tab shows which module's registrations grow. Report it to that module's author, or disable it for a session to confirm." },
  { f: "intervals", min: 3, high: 20, blame: "intervals", what: "Repeating timers keep piling up",
    why: "Each one wakes the page on a schedule forever.", next: "The Modules tab shows who creates them." },
  { f: "listeners", min: 20, high: 100, blame: "listeners", what: "Page-wide event listeners keep piling up",
    why: "Each mouse move or key press runs every one of them.", next: "The Modules tab shows who adds them." },
  { f: "threeGeo", min: 50, high: 300, what: "3D geometry keeps piling up", why: "3D Canvas models or effects are loaded and not disposed.", next: "Tools → Clear the 3D model cache, then change scene and back." },
  { f: "threeTex", min: 20, high: 150, what: "3D textures keep piling up", why: "3D Canvas textures are loaded and not disposed.", next: "Tools → Clear the 3D model cache." },
  { f: "threeProg", min: 5, high: 30, what: "3D shader programs keep piling up", why: "New shaders are compiled over and over — often materials cloned per token or per effect.", next: "Watch whether it grows on token moves or on effects." },
  { f: "seqEffects", min: 5, high: 20, what: "Sequencer effects keep running and piling up", why: "Persistent effects left on tokens or the scene keep animating every frame.", next: "Tools → End all Sequencer effects." },
  { f: "sounds", min: 3, high: 10, what: "More and more sounds are playing", why: "Sounds that never stop still decode audio.", next: "Check the playlists and ambient sounds." },
  { f: "frameP95", min: 5, high: 20, what: "Frames get slower as the session goes on",
    why: "Even without a visible leak, the page is doing more work per frame than at the start.", next: "Compare the Modules tab now against early in the session; the owner whose time grows is the cause." },
  { f: "hookMs", min: 40, high: 200, what: "Hooks take longer and longer", why: "The same events cost more each time — usually because more callbacks run for them.", next: "Modules tab, hook time column." },
  { f: "pingMs", min: 50, high: 250, what: "The server answers more slowly as the session goes on",
    why: "This one is on the server side (or the network), not in this browser tab. Refreshing the page won't fix it; restarting the world will.", next: "Check the server machine's memory and CPU. Large world databases and busy modules that write constantly are the usual causes." },
];

export function trends() {
  const out = [];
  for (const g of GROWTH) {
    const t = trend(g.f);
    if (!t || t.r2 < 0.55 || t.slope < g.min) continue;
    out.push({ ...g, t, sev: t.slope >= g.high ? "high" : "medium" });
  }
  return out;
}

/** Owners whose registrations / intervals / listeners grew most since the first snapshot. */
export function growthBy(kind) {
  if (S.regs.length < 2) return [];
  const a = S.regs[0][kind] ?? {}, b = S.regs.at(-1)[kind] ?? {};
  return Object.keys({ ...a, ...b }).map((o) => ({ owner: o, from: a[o] ?? 0, to: b[o] ?? 0, delta: (b[o] ?? 0) - (a[o] ?? 0) }))
    .filter((x) => x.delta > 0).sort((x, y) => y.delta - x.delta);
}

// ─────────────────────────────────────────────────────────────── per-module blame
export function blame() {
  const mins = Math.max(1, (Date.now() - I.started) / 60000);
  const regs = hookRegistrations(), ints = intervalsByOwner(), lis = listenersByOwner();
  const regGrow = Object.fromEntries(growthBy("hooks").map((x) => [x.owner, x.delta]));
  const intGrow = Object.fromEntries(growthBy("intervals").map((x) => [x.owner, x.delta]));
  const lisGrow = Object.fromEntries(growthBy("listeners").map((x) => [x.owner, x.delta]));
  const owners = new Set([...I.owners.keys(), ...Object.keys(regs), ...Object.keys(ints), ...Object.keys(lis)]);
  owners.delete(MODULE_ID);
  const rows = [];
  for (const o of owners) {
    const v = I.owners.get(o) ?? {};
    const row = {
      owner: o,
      title: o === "core" ? "Foundry core" : o.startsWith("system:") ? `System: ${game.system?.title ?? o.slice(7)}` : (game.modules.get(o)?.title ?? o),
      slowMs: (v.loafMs ?? 0) / mins, layoutMs: (v.layoutMs ?? 0) / mins,
      hookMs: (v.hookMs ?? 0) / mins, hookCalls: (v.hookCalls ?? 0) / mins,
      timerMs: (v.intervalMs ?? 0) / mins,
      regs: regs[o] ?? 0, regGrow: regGrow[o] ?? 0,
      intervals: ints[o] ?? 0, intGrow: intGrow[o] ?? 0,
      listeners: lis[o] ?? 0, lisGrow: lisGrow[o] ?? 0,
      errors: v.errors ?? 0, warns: v.warns ?? 0,
      sock: ((v.sockIn ?? 0) + (v.sockOut ?? 0)) / mins,
    };
    row.cost = row.slowMs + row.hookMs + row.timerMs;
    rows.push(row);
  }
  return rows.sort((a, b) => b.cost - a.cost || b.regGrow - a.regGrow);
}

// ─────────────────────────────────────────────────────────────── suspects
function recent(field, k = 4) { return median(S.rows.filter((r) => !r.hidden).slice(-k).map((r) => r[field])); }

function topOf(map, field, k = 3) {
  return [...map.entries()].map(([name, v]) => ({ name, v: typeof v === "object" ? v[field] : v }))
    .filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, k);
}

export function suspects() {
  const out = [];
  const add = (sev, title, detail, next, tags = []) => out.push({ sev, title, detail, next, tags });
  const rows = S.rows.filter((r) => !r.hidden);
  const last = S.rows.at(-1);

  // 1. things that grow
  for (const g of trends()) {
    let detail = `${FIELDS[g.f]?.label ?? g.f}: ${fmt(g.t.start)} → ${fmt(g.t.end)} over ${fmt(g.t.span)} minutes (about +${fmt(g.t.slope, g.t.slope < 10 ? 1 : 0)} ${FIELDS[g.f]?.unit ?? ""} per hour). ${g.why}`;
    if (g.blame) {
      const top = growthBy(g.blame).slice(0, 3);
      if (top.length) detail += ` Growing most: ${top.map((x) => `${label(x.owner)} (+${x.delta})`).join(", ")}.`;
    }
    add(g.sev, g.what, detail, g.next, ["leak"]);
  }

  if (rows.length) {
    // 2. how it feels right now
    const fps = recent("fps"), p95 = recent("frameP95"), stall = recent("stallMax"), big = recent("bigHitches");
    if (fps !== null && fps < 40) add(fps < 25 ? "high" : "medium", `Low frame rate (${fps} fps)`,
      `Frames are taking ${fmt(p95)} ms at the slow end (a smooth 60 fps frame is 17 ms).`,
      "See the Modules tab for who is using the time, and Checkup for graphics settings.", ["now"]);
    else if (p95 !== null && p95 > 50) add(p95 > 100 ? "high" : "medium", `Choppy frames (slowest 5% take ${p95} ms)`,
      "The average is fine but regular slow frames make movement and scrolling stutter.", "The Slow frames list shows exactly what ran in each one.", ["now"]);
    if (stall !== null && stall > 300) add(stall > 1000 ? "high" : "medium", `The page freezes for up to ${fmt(stall)} ms`,
      "During a freeze nothing responds — clicks, dragging, chat.", "Slow frames list: the longest entries name the script.", ["now"]);
    if (big !== null && big >= 3) add("medium", `${big} freezes over a quarter of a second in the last sample`, "Short freezes that players feel as a hitch.", "Slow frames list.", ["now"]);

    const heap = recent("heapMB"), lim = last?.heapLimitMB;
    if (heap && lim && heap / lim > 0.6) add(heap / lim > 0.8 ? "high" : "medium", `JavaScript memory is at ${Math.round((heap / lim) * 100)}% of its limit`,
      `${fmt(heap)} MB of ${fmt(lim)} MB. Near the limit the browser spends more and more time cleaning up memory, which feels like freezes.`,
      "Refresh (F5) to reset it now; the leak checks above say what is filling it.", ["now"]);
    const gmb = recent("gpuTexMB");
    if (gmb > 1000) add(gmb > 2000 ? "high" : "medium", `${fmt(gmb)} MB of images on the graphics card`,
      "Big maps, animated tiles and effect videos all sit in video memory. Past what the card has, it starts swapping and frames slow down.",
      "Checkup → Largest images on this scene. Tools → Free unused textures.", ["now"]);
    const tris = recent("threeTris");
    if (tris > 5e6) add(tris > 15e6 ? "high" : "medium", `3D scene draws ${fmt(tris / 1e6, 1)} million triangles a frame`,
      "Every frame redraws all of them. High-detail models are the usual cause.", "Swap the heaviest models for lighter versions or reduce how many are on the scene.", ["now"]);
    const ping = recent("pingMs");
    if (ping > 300) add(ping > 1000 ? "high" : "medium", `The server takes ${fmt(ping)} ms to answer`,
      "Everything that saves (moving tokens, rolling, editing) waits on this. It's the server or the network, not this browser tab.",
      "Check the server machine's CPU and memory. Socket traffic below shows what is being sent.", ["now", "server"]);
    const vp = recent("videosPlaying");
    if (vp > 20) add("medium", `${vp} videos are playing at once`, "Each playing video decodes frames continuously.", "Animated tiles, token art and effects. Tools → End all Sequencer effects.", ["now"]);

    // 3. storms: something happening far too often
    const renders = recent("renders");
    if (renders > 300) {
      const top = topOf(I.hookCalls, "calls").filter((x) => /^render/.test(x.name));
      add("medium", `Windows re-render ${fmt(renders)} times a minute`,
        `Constant re-rendering burns time on layout. Busiest: ${top.map((x) => x.name.replace(/^render/, "")).join(", ") || "—"}.`,
        "Close windows you aren't using. A module that updates a document every second will cause this.", ["storm"]);
    }
    const refr = recent("refreshes");
    if (refr > 3000) {
      const top = topOf(I.hookCalls, "calls").filter((x) => /^refresh/.test(x.name));
      add("medium", `Map objects refresh ${fmt(refr)} times a minute`, `Busiest: ${top.map((x) => x.name.replace(/^refresh/, "")).join(", ")}.`,
        "Usually a module updating tokens on a timer, or an aura / light effect animating.", ["storm"]);
    }
    const du = recent("docUpdates");
    if (du > 300) {
      const top = topOf(I.hookCalls, "calls").filter((x) => /^(create|update|delete)[A-Z]/.test(x.name));
      add("medium", `${fmt(du)} document changes a minute`, `Every change goes through the server to every player. Busiest: ${top.map((x) => x.name).join(", ")}.`,
        "Socket tab shows who sends them.", ["storm", "server"]);
    }
    const sin = recent("sockIn");
    if (sin > 1500) {
      const top = topOf(I.sockIn, "n");
      add("medium", `${fmt(sin)} socket messages a minute arriving`, `Top: ${top.map((x) => `${x.name} (${fmt(x.v)})`).join(", ")}.`, "A module broadcasting on a timer is the usual cause.", ["storm", "server"]);
    }
    const er = recent("errors");
    if (er > 30) {
      const top = [...I.errorSamples].sort((a, b) => b.n - a.n).slice(0, 2);
      add("medium", `${fmt(er)} console errors a minute`, `Errors in a loop cost time and usually mean something is broken. ${top.map((e) => `${label(e.owner)}: "${e.msg.slice(0, 80)}"`).join(" · ")}`,
        "Fix or disable the module named.", ["storm"]);
    }
    const side = recent("sidebarNodes");
    if (side > 15000) add("medium", `The sidebar holds ${fmt(side)} elements`,
      "A huge sidebar makes every layout pass slower — on this setup a playlist tab with thousands of sound rows has done exactly this before.",
      "Collapse big playlist folders, or switch to a lighter sidebar tab during play.", ["now"]);
  }

  // 4. the same callback registered over and over (a leak visible straight away)
  const copies = new Map();
  for (const r of I.hookEntries.values()) {
    if (r.owner === MODULE_ID || r.name === "anonymous") continue;
    const k = `${r.owner}|${r.hook}|${r.name}`;
    copies.set(k, (copies.get(k) ?? 0) + 1);
  }
  for (const [k, c] of [...copies.entries()].filter(([, c]) => c >= 10).sort((a, b) => b[1] - a[1]).slice(0, 3)) {
    const [o, hook, name] = k.split("|");
    if (Hooks.events?.[hook]?.filter((e) => (e.fn?.__ldOrig ?? e.fn)?.name === name).length < 10) continue;   // already removed
    add(c >= 50 ? "high" : "medium", `${label(o)} has registered the same callback ${c} times`,
      `"${name}" on the ${hook} hook is registered ${c} times, so it runs ${c} times every time ${hook} fires. That's almost always a leak — it gets registered on every render or update and never removed.`,
      "Disable that module for a session to confirm, and report it to its author.", ["leak", "module"]);
  }

  // 5. per-module blame
  const mins = Math.max(1, (Date.now() - I.started) / 60000);
  if (mins >= 3) {
    for (const b of blame().slice(0, 6)) {
      if (b.owner === "core" || b.owner === "unknown") continue;
      if (b.cost > 150) add(b.cost > 500 ? "high" : "medium", `${b.title} uses ${fmt(b.cost)} ms of main-thread time a minute`,
        `${fmt(b.slowMs)} ms in slow frames, ${fmt(b.hookMs)} ms in its hooks, ${fmt(b.timerMs)} ms in its timers. ${b.layoutMs > 20 ? `${fmt(b.layoutMs)} ms of that is forcing page layout. ` : ""}`,
        "Disable it for a session and compare. If it's essential, check its settings for animation or update frequency.", ["module"]);
    }
  }
  const order = { high: 0, medium: 1, low: 2, ok: 3 };
  return out.sort((a, b) => order[a.sev] - order[b.sev]);
}

export function label(owner) {
  if (owner === "core") return "Foundry core";
  if (owner?.startsWith("system:")) return `System (${owner.slice(7)})`;
  return game.modules.get(owner)?.title ?? owner;
}

// ─────────────────────────────────────────────────────────────── checkup
const HEAVY = {
  "dice-so-nice": "3D dice run their own WebGL renderer and animate on every client for every roll.",
  "sequencer": "Keeps up to 500 MB of effect video in memory by design. That plateau is not a leak.",
  "fxmaster": "Weather and particle effects run shaders on every frame.",
  "tokenmagic": "Filters run per token; animated filters cost every frame.",
  "levels-3d-preview": "3D Canvas redraws every model every frame; high-poly models dominate.",
  "autoanimations": "Plays an effect on every attack and spell.",
  "perfect-vision": "Adds extra vision and lighting passes.",
  "weatherblock": "Adds weather rendering.",
};

export async function checkup() {
  const out = [];
  const add = (group, sev, title, detail = "", fix = "") => out.push({ group, sev, title, detail, fix });

  // machine
  const gl = n(() => canvas.app.renderer.gl);
  let gpu = null;
  if (gl) {
    const ext = n(() => gl.getExtension("WEBGL_debug_renderer_info"));
    gpu = n(() => gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  }
  if (gpu) {
    if (/swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(gpu))
      add("Machine", "high", "Graphics are running in SOFTWARE", `Renderer: ${gpu}. The graphics card isn't being used at all, so everything on the map is drawn by the CPU.`,
        "Turn on hardware acceleration (browser settings → System), update the graphics driver, and in Windows Graphics Settings set the browser or Foundry app to High performance.");
    else if (/intel/i.test(gpu) && !/nvidia|amd|radeon|arc/i.test(gpu))
      add("Machine", "low", "Integrated graphics", `Renderer: ${gpu}. If this PC also has a dedicated card, the browser isn't using it.`, "Windows → Settings → Display → Graphics: set the browser/Foundry to High performance.");
    else add("Machine", "ok", "Graphics card in use", gpu);
  }
  const cores = navigator.hardwareConcurrency, ram = navigator.deviceMemory;
  add("Machine", cores && cores < 4 ? "medium" : "ok", `${cores ?? "?"} CPU threads${ram ? `, ${ram}+ GB memory reported` : ""}`,
    cores && cores < 4 ? "Few CPU threads: the server and the page compete for the same cores." : "");
  const lim = performance.memory ? Math.round(performance.memory.jsHeapSizeLimit / 1048576) : null;
  if (lim) add("Machine", lim < 2100 ? "low" : "ok", `JavaScript memory limit: ${lim.toLocaleString()} MB`);
  const electron = /Electron/i.test(navigator.userAgent);
  add("Machine", electron ? "low" : "ok", electron ? "Running in the Foundry desktop app" : "Running in a browser",
    electron ? "The desktop app is both the server and your client. If you host and GM on one PC, joining as GM from Chrome at localhost:30000 lets you refresh the page without touching the server, and gives you DevTools." : "");
  const dpr = window.devicePixelRatio || 1;
  const scaling = n(() => game.settings.get("core", "pixelRatioResolutionScaling"));
  if (dpr > 1.2 && scaling) add("Settings", "medium", `Canvas renders at ${dpr}× resolution`, "Your display is scaled, and Foundry draws the map at full pixel density — up to 4× the pixels.",
    "Configure Settings → Core → turn off 'Resolution Scaling' (pixel ratio), or lower Windows display scaling.");
  let est = null;
  try { est = await navigator.storage?.estimate?.(); } catch { /* */ }
  if (est?.quota && est.usage / est.quota > 0.8) add("Machine", "low", "Browser storage is nearly full", `${Math.round(est.usage / 1048576)} MB used of ${Math.round(est.quota / 1048576)} MB.`, "Clear site data for Foundry in the browser.");

  // settings
  const perf = n(() => canvas.performance?.mode);
  const perfNames = ["Low", "Medium", "High", "Maximum"];
  if (perf !== null) add("Settings", perf >= 2 ? "low" : "ok", `Canvas performance mode: ${perfNames[perf] ?? perf}`,
    perf >= 2 ? "High/Maximum turns on softer shadows, higher-quality textures and more light detail." : "", perf >= 2 ? "Configure Settings → Core → Performance Mode → Medium, if frames are slow." : "");
  const fpsCap = n(() => game.settings.get("core", "maxFPS"));
  if (fpsCap) add("Settings", "ok", `Frame rate cap: ${fpsCap}`, fpsCap >= 60 ? "Setting it to 30 halves the drawing work, which helps weaker machines a lot." : "");
  if (n(() => game.settings.get("core", "lightAnimation")) && n(() => canvas.lighting.placeables.filter((l) => l.document.config?.animation?.type).length) > 15)
    add("Settings", "low", "Many animated lights on this scene", "Every animated light redraws every frame.", "Turn off 'Animate Lighting' in Core settings for this client, or reduce animated lights.");

  // scene
  const sc = canvas?.scene;
  if (sc) {
    const d = sc.dimensions;
    const mp = d ? (d.width * d.height) / 1e6 : 0;
    add("Scene", mp > 100 ? "medium" : "ok", `Scene size ${fmt(d?.width)} × ${fmt(d?.height)} px`, mp > 100 ? `${fmt(mp)} megapixels. Very large scenes cost memory for lighting, vision and fog.` : "");
    const walls = canvas.walls?.placeables.length ?? 0;
    if (walls > 2000) add("Scene", walls > 5000 ? "high" : "medium", `${fmt(walls)} walls`, "Vision and lighting are recalculated against every wall when tokens move.", "Simplify wall layouts (fewer, longer segments), or split the map.");
    const lights = canvas.lighting?.placeables.length ?? 0;
    if (lights > 100) add("Scene", "medium", `${fmt(lights)} lights`, "Each light has its own shape to recompute when walls or doors change.");
    const vis = canvas.tokens?.placeables.filter((t) => t.document.sight?.enabled).length ?? 0;
    if (vis > 25) add("Scene", "low", `${vis} tokens with vision`, "Each token with sight computes its own vision polygon. NPC tokens rarely need vision turned on.");
    const vids = canvas.tiles?.placeables.filter((t) => t.isVideo || /\.(webm|mp4|m4v|ogv)$/i.test(t.document.texture?.src ?? "")).length ?? 0;
    if (vids) add("Scene", vids > 8 ? "medium" : "low", `${vids} video tiles`, "Each video tile decodes frames continuously.");
    const snd = canvas.sounds?.placeables.length ?? 0;
    if (snd > 40) add("Scene", "low", `${snd} ambient sounds`, "Each one is checked against walls as tokens move.");
    // biggest textures
    const list = n(() => canvas.app.renderer.texture.managedTextures, []) ?? [];
    const big = list.filter(Boolean).map((t) => {
      const w = t.realWidth ?? t.width, h = t.realHeight ?? t.height;
      const src = t.resource?.src ?? t.resource?.url ?? t.resource?.source?.src ?? t.resource?.source?.currentSrc ?? t.cacheId ?? "";
      return { w, h, mb: (w * h * 4) / 1048576, src: String(src).replace(/^.*?\/\/[^/]+\//, "") };
    }).filter((x) => x.w && x.h && x.src && !/^blob:|^data:/.test(x.src)).sort((a, b) => b.mb - a.mb).slice(0, 8);
    for (const b of big) add("Largest images", b.w > 8192 || b.h > 8192 ? "medium" : b.mb > 64 ? "low" : "ok",
      `${b.w} × ${b.h} — ${fmt(b.mb)} MB on the GPU`, b.src, b.w > 8192 || b.h > 8192 ? "Over 8192 px on a side: many graphics cards have to downscale or split it. Export at 4096–8192 px." : "");
  }

  // modules
  const active = game.modules.filter((m) => m.active);
  add("Modules", active.length > 100 ? "medium" : active.length > 60 ? "low" : "ok", `${active.length} modules active`,
    active.length > 60 ? "Every module adds scripts, hooks and CSS. Finding a culprit among this many by guessing doesn't work — use the Modules tab here, then disable in halves by role (animation/dice/effects vs the rest)." : "");
  for (const [id, why] of Object.entries(HEAVY)) if (game.modules.get(id)?.active) add("Modules", "low", `${game.modules.get(id).title} is active`, why);
  const dice = active.filter((m) => /dice/i.test(m.id));
  if (dice.length > 2) add("Modules", "medium", `${dice.length} dice modules active`, dice.map((m) => m.title).join(", "), "Each one hooks into every roll. Keep the ones you use.");
  const anim = active.filter((m) => /anim|sequencer|jb2a|fxmaster|tokenmagic|effects/i.test(m.id));
  if (anim.length > 3) add("Modules", "low", `${anim.length} animation / effect modules active`, anim.map((m) => m.title).join(", "));

  // world
  const msgs = game.messages?.size ?? 0;
  if (msgs > 2000) add("World", msgs > 8000 ? "medium" : "low", `${fmt(msgs)} chat messages`, "The whole log loads with the world and every client keeps it in memory.", "Export and flush the chat log between sessions.");
  const sounds = game.playlists?.reduce((a, p) => a + p.sounds.size, 0) ?? 0;
  if (sounds > 500) add("World", "low", `${fmt(sounds)} playlist sounds`, "With the Playlists tab open, every row is on the page; the playing-track clock updates every second.", "Keep big playlists collapsed during play.");
  const actors = game.actors?.size ?? 0;
  if (actors > 1500) add("World", "low", `${fmt(actors)} actors in the world`, "They all load for every client at join. Compendiums don't.");
  add("World", "ok", `${game.users.filter((u) => u.active).length} users connected`);

  // measurement coverage
  if (!I.support.loaf) add("This tool", "low", "Per-script blame not available in this browser", "Long Animation Frames needs Chrome/Edge 123+ or a current Foundry app. Frame and hook timing still work.");
  const early = [...I.hookEntries.values()].filter((r) => r.owner.startsWith("registered before")).length;
  if (early) add("This tool", "ok", `${early} hook callbacks were registered before Lag Detective loaded`, "They are timed, but can't be tied to a module, so they show as 'registered before Lag Detective loaded'.");
  return out;
}
