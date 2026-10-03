/**
 * Lag Detective — the always-on measurement layer.
 *
 * Everything here is cheap enough to leave running all session:
 *  - frame timing from a requestAnimationFrame loop
 *  - main-thread stalls from a timer that notices when it fires late
 *  - Long Animation Frames (Chromium) with the script behind each slow frame, mapped to a module
 *  - per-callback hook timing, with the module that registered each callback
 *  - hook call counts (document updates, sheet renders, token refreshes …)
 *  - intervals, global event listeners and console errors, each attributed to a module
 *  - socket traffic in and out, broken down by event and document type
 *
 * Nothing here writes to the world, sends chat, or changes how other code behaves.
 */
export const MODULE_ID = "lag-detective";

const now = () => performance.now();

/** Which package does a URL or stack trace belong to? */
export function ownerOfUrl(url) {
  if (!url) return "unknown";
  const m = /\/(modules|systems)\/([^/]+)\//.exec(url);
  if (m) return m[1] === "systems" ? `system:${m[2]}` : m[2];
  if (/\/(scripts|client|common)\/|foundry\.m?js|\/vendor\//.test(url)) return "core";
  if (/^chrome-extension:|^moz-extension:/.test(url)) return "browser-extension";
  return "unknown";
}

export function ownerOfStack(stack) {
  if (!stack) return "unknown";
  for (const line of stack.split("\n").slice(1)) {
    if (line.includes(`/modules/${MODULE_ID}/scripts/instrument.js`)) continue;
    const m = /\/(modules|systems)\/([^/]+)\//.exec(line);
    if (m) return m[1] === "systems" ? `system:${m[2]}` : m[2];
  }
  // no package in the stack: core or an inline macro/console script
  return /\/(scripts|client|common)\/|foundry\.m?js/.test(stack) ? "core" : "macro / console";
}
const stackOwner = () => ownerOfStack(new Error().stack);

/** A per-owner accumulator. */
function bump(map, key, fields) {
  let e = map.get(key);
  if (!e) map.set(key, (e = {}));
  for (const [k, v] of Object.entries(fields)) {
    if (k === "max") e.max = Math.max(e.max ?? 0, v);
    else e[k] = (e[k] ?? 0) + v;
  }
  return e;
}

// ─────────────────────────────────────────────────────────────── shared state
/**
 * Two kinds of numbers:
 *  - "window" counters, reset every sample (per-interval rates)
 *  - "session" totals, kept for the whole session (per-module blame tables)
 */
export const I = {
  started: Date.now(),
  support: { loaf: false, longtask: false, memory: !!performance.memory, onAny: false },

  // frames
  frames: { deltas: new Float32Array(4096), n: 0, hitch50: 0, hitch100: 0, hitch250: 0, max: 0, hiddenMs: 0 },
  rafCalls: 0,
  // main thread
  loop: { max: 0, over100: 0, over500: 0 },
  longFrames: { count: 0, blockedMs: 0, totalMs: 0, forcedLayoutMs: 0 },
  worstFrames: [],                  // last 40 long frames with their scripts
  // per owner (session totals)
  owners: new Map(),                // owner -> { loafMs, loafCount, layoutMs, hookMs, hookCalls, intervalMs, intervalRuns, errors, warns, sockOut, sockIn }
  ownersWin: new Map(),             // same, for the current window only
  // hooks
  hookEntries: new Map(),           // entry id -> { hook, owner, name, calls, ms, max }
  hookCalls: new Map(),             // hook name -> { calls, ms } session
  hookCallsWin: new Map(),          // hook name -> { calls, ms } window
  hookRegOwner: new Map(),          // entry id -> owner (from the stack at registration)
  // timers / listeners
  intervals: new Map(),             // id -> { owner, delay, at }
  timeoutsWin: 0,
  globalListeners: new Map(),       // "owner|target|type" -> count
  // sockets
  sockIn: new Map(), sockOut: new Map(),           // event -> { n, bytes } session
  sockInWin: { n: 0, bytes: 0 }, sockOutWin: { n: 0, bytes: 0 },
  sockReconnects: 0, sockDisconnects: 0,
  // errors
  errorsWin: 0, warnsWin: 0, uncaught: 0,
  errorSamples: [],                 // last 30 distinct error messages { owner, msg, n, last }
  measureBytes: true,
  hookTiming: true,
};

function owner(o) { return bump(I.owners, o, {}); }
function ownerWin(o) { return bump(I.ownersWin, o, {}); }
function addOwner(o, fields) { bump(I.owners, o, fields); bump(I.ownersWin, o, fields); }

// Keep references to the untouched browser functions for our own use.
const _setInterval = window.setInterval.bind(window);
const _setTimeout = window.setTimeout.bind(window);
const _raf = window.requestAnimationFrame.bind(window);

// ─────────────────────────────────────────────────────────────── frames
let lastFrame = 0;
function frameLoop(t) {
  if (lastFrame) {
    const d = t - lastFrame;
    if (document.hidden) I.frames.hiddenMs += d;
    else {
      const f = I.frames;
      f.deltas[f.n % f.deltas.length] = d;
      f.n++;
      if (d > 50) f.hitch50++;
      if (d > 100) f.hitch100++;
      if (d > 250) f.hitch250++;
      if (d > f.max) f.max = d;
    }
  }
  lastFrame = t;
  _raf(frameLoop);
}

// ─────────────────────────────────────────────────────────────── main-thread stalls
function loopLag() {
  let expected = now() + 250;
  _setInterval(() => {
    const t = now();
    const late = t - expected;
    expected = t + 250;
    if (document.hidden) return;        // background tabs are throttled on purpose
    if (late > I.loop.max) I.loop.max = late;
    if (late > 100) I.loop.over100++;
    if (late > 500) I.loop.over500++;
  }, 250);
}

// ─────────────────────────────────────────────────────────────── long animation frames
function observeLongFrames() {
  const types = PerformanceObserver.supportedEntryTypes ?? [];
  if (types.includes("long-animation-frame")) {
    I.support.loaf = true;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (document.hidden) continue;
        const lf = I.longFrames;
        lf.count++;
        lf.totalMs += e.duration;
        lf.blockedMs += e.blockingDuration ?? 0;
        const scripts = [];
        for (const s of e.scripts ?? []) {
          const who = ownerOfUrl(s.sourceURL);
          const layout = s.forcedStyleAndLayoutDuration ?? 0;
          if (who === MODULE_ID) continue;
          addOwner(who, { loafMs: s.duration, loafCount: 1, layoutMs: layout });
          lf.forcedLayoutMs += layout;
          if (s.duration >= 5) scripts.push({
            owner: who, ms: Math.round(s.duration), layoutMs: Math.round(layout),
            fn: s.sourceFunctionName || "", invoker: s.invoker || s.invokerType || "",
            url: (s.sourceURL || "").replace(/^.*?\/(modules|systems|scripts)\//, "$1/"),
          });
        }
        // attributing the rest of the frame: style / layout / paint the scripts didn't cover
        const scripted = (e.scripts ?? []).reduce((a, s) => a + s.duration, 0);
        const render = e.renderStart ? Math.max(0, e.startTime + e.duration - e.renderStart) : 0;
        if (e.duration >= 100) {
          I.worstFrames.push({
            at: Date.now(), ms: Math.round(e.duration), blockedMs: Math.round(e.blockingDuration ?? 0),
            scriptMs: Math.round(scripted), renderMs: Math.round(render),
            scripts: scripts.sort((a, b) => b.ms - a.ms).slice(0, 5),
          });
          if (I.worstFrames.length > 40) I.worstFrames.shift();
        }
      }
    }).observe({ type: "long-animation-frame", buffered: false });
  } else if (types.includes("longtask")) {
    I.support.longtask = true;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (document.hidden) continue;
        I.longFrames.count++;
        I.longFrames.totalMs += e.duration;
        I.longFrames.blockedMs += Math.max(0, e.duration - 50);
      }
    }).observe({ type: "longtask", buffered: false });
  }
}

// ─────────────────────────────────────────────────────────────── hooks
/** Wrap one registered hook entry so its time is measured. */
function wrapEntry(entry) {
  const fn = entry.fn;
  if (typeof fn !== "function" || fn.__ldOrig) return;
  const rec = {
    hook: entry.hook,
    owner: I.hookRegOwner.get(entry.id) ?? "registered before Lag Detective loaded",
    name: fn.name || "anonymous",
    calls: 0, ms: 0, max: 0,
  };
  I.hookEntries.set(entry.id, rec);
  const w = function (...args) {
    if (!I.hookTiming) return fn.apply(this, args);
    const t = now();
    try { return fn.apply(this, args); }
    finally {
      const d = now() - t;
      rec.calls++; rec.ms += d; if (d > rec.max) rec.max = d;
      const o = I.owners.get(rec.owner) ?? owner(rec.owner);
      o.hookMs = (o.hookMs ?? 0) + d; o.hookCalls = (o.hookCalls ?? 0) + 1;
      const ow = I.ownersWin.get(rec.owner) ?? ownerWin(rec.owner);
      ow.hookMs = (ow.hookMs ?? 0) + d; ow.hookCalls = (ow.hookCalls ?? 0) + 1;
    }
  };
  w.__ldOrig = fn;
  Object.defineProperty(w, "name", { value: fn.name });
  entry.fn = w;
}

/** Wrap every entry not yet wrapped; returns total registered callbacks. */
/** Foundry defines each hook's list as a non-enumerable property, so Object.values() sees nothing. */
function hookLists() {
  const ev = Hooks.events ?? {};
  return Object.getOwnPropertyNames(ev).map((k) => [k, ev[k]]);
}

export function sweepHooks() {
  let total = 0;
  const lists = hookLists();
  for (const [, list] of lists) {
    if (!Array.isArray(list)) continue;
    total += list.length;
    for (const e of list) wrapEntry(e);
  }
  // forget entries that are gone
  if (I.hookEntries.size > total * 1.5 + 200) {
    const live = new Set(lists.flatMap(([, l]) => (Array.isArray(l) ? l : [])).map((e) => e.id));
    for (const id of I.hookEntries.keys()) if (!live.has(id)) I.hookEntries.delete(id);
  }
  return total;
}

/** Registered callbacks per owner right now (for leak detection). */
export function hookRegistrations() {
  const out = {};
  for (const [, list] of hookLists()) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      const o = I.hookEntries.get(e.id)?.owner ?? I.hookRegOwner.get(e.id) ?? "unknown";
      out[o] = (out[o] ?? 0) + 1;
    }
  }
  return out;
}

export function hookCountsByName() {
  const out = {};
  for (const [k, list] of hookLists()) if (Array.isArray(list)) out[k] = list.length;
  return out;
}

function patchHooks() {
  const H = globalThis.Hooks;
  if (!H || H.__ldPatched) return;
  H.__ldPatched = true;

  const on = H.on;
  H.on = function (hook, fn, opts) {
    const id = on.call(this, hook, fn, opts);
    try {
      I.hookRegOwner.set(id, stackOwner());
      const list = this.events?.[hook];
      const entry = list && list[list.length - 1]?.id === id ? list[list.length - 1] : list?.find((e) => e.id === id);
      if (entry) wrapEntry(entry);
    } catch { /* never break registration */ }
    return id;
  };
  // Hooks.once calls this.on, so it is covered.

  // off(hook, fn) compares entry.fn === fn; translate the original function to its entry id.
  const off = H.off;
  H.off = function (hook, fn) {
    if (typeof fn === "function") {
      const e = this.events?.[hook]?.find((x) => x.fn === fn || x.fn?.__ldOrig === fn);
      if (e) return off.call(this, hook, e.id);
    }
    return off.call(this, hook, fn);
  };

  // count every hook fired (cheap): document updates, renders, refreshes …
  for (const name of ["call", "callAll"]) {
    const orig = H[name];
    H[name] = function (hook, ...args) {
      const t = now();
      try { return orig.call(this, hook, ...args); }
      finally {
        const d = now() - t;
        let s = I.hookCalls.get(hook); if (!s) I.hookCalls.set(hook, (s = { calls: 0, ms: 0 }));
        s.calls++; s.ms += d;
        let w = I.hookCallsWin.get(hook); if (!w) I.hookCallsWin.set(hook, (w = { calls: 0, ms: 0 }));
        w.calls++; w.ms += d;
      }
    };
  }
  sweepHooks();
}

// ─────────────────────────────────────────────────────────────── timers
let _timerIds = 0;
function patchTimers() {
  const si = window.setInterval, ci = window.clearInterval, st = window.setTimeout, raf = window.requestAnimationFrame;
  window.setInterval = function (cb, delay, ...rest) {
    let who = "unknown";
    try { who = stackOwner(); } catch { /* */ }
    let fn = cb;
    if (typeof cb === "function") {
      fn = function (...a) {
        const t = now();
        try { return cb.apply(this, a); }
        finally { addOwner(who, { intervalMs: now() - t, intervalRuns: 1 }); }
      };
    }
    const id = si.call(window, fn, delay, ...rest);
    I.intervals.set(id, { owner: who, delay: Number(delay) || 0, at: Date.now() });
    return id;
  };
  window.clearInterval = function (id) { I.intervals.delete(id); return ci.call(window, id); };
  window.setTimeout = function (...a) { I.timeoutsWin++; return st.apply(window, a); };
  window.requestAnimationFrame = function (cb) { I.rafCalls++; return raf.call(window, cb); };
}

export function intervalsByOwner() {
  const out = {};
  for (const v of I.intervals.values()) out[v.owner] = (out[v.owner] ?? 0) + 1;
  return out;
}

// ─────────────────────────────────────────────────────────────── global listeners
const listenerOwner = new WeakMap();   // listener fn -> owner key
function patchListeners() {
  const add = EventTarget.prototype.addEventListener;
  const rem = EventTarget.prototype.removeEventListener;
  const isGlobal = (t) => t === window || t === document || t === document.body || t === document.documentElement;
  const tname = (t) => (t === window ? "window" : t === document ? "document" : "body");
  EventTarget.prototype.addEventListener = function (type, listener, opts) {
    if (listener && isGlobal(this)) {
      try {
        const key = `${stackOwner()}|${tname(this)}|${type}`;
        let m = listenerOwner.get(listener);
        if (!m) listenerOwner.set(listener, (m = new Map()));
        const mk = `${tname(this)}|${type}`;
        if (!m.has(mk)) {
          m.set(mk, key);
          I.globalListeners.set(key, (I.globalListeners.get(key) ?? 0) + 1);
        }
      } catch { /* */ }
    }
    return add.call(this, type, listener, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, opts) {
    if (listener && isGlobal(this)) {
      const m = listenerOwner.get(listener);
      const mk = `${tname(this)}|${type}`;
      const key = m?.get(mk);
      if (key) { m.delete(mk); const n = (I.globalListeners.get(key) ?? 1) - 1; if (n > 0) I.globalListeners.set(key, n); else I.globalListeners.delete(key); }
    }
    return rem.call(this, type, listener, opts);
  };
}

export function listenersByOwner() {
  const out = {};
  for (const [k, n] of I.globalListeners) { const o = k.split("|")[0]; out[o] = (out[o] ?? 0) + n; }
  return out;
}
export function totalGlobalListeners() { let t = 0; for (const n of I.globalListeners.values()) t += n; return t; }

// ─────────────────────────────────────────────────────────────── errors
let errStackBudget = 0;
function noteError(kind, args) {
  if (kind === "error") I.errorsWin++; else I.warnsWin++;
  if (errStackBudget <= 0) return;           // stack capture is rate limited
  errStackBudget--;
  try {
    const who = stackOwner();
    addOwner(who, kind === "error" ? { errors: 1 } : { warns: 1 });
    const msg = args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : "")).join(" ").trim().slice(0, 160);
    if (!msg) return;
    const key = `${who}|${msg}`;
    const hit = I.errorSamples.find((e) => e.key === key);
    if (hit) { hit.n++; hit.last = Date.now(); return; }
    I.errorSamples.push({ key, owner: who, kind, msg, n: 1, last: Date.now() });
    if (I.errorSamples.length > 30) I.errorSamples.sort((a, b) => b.last - a.last).pop();
  } catch { /* */ }
}
function patchConsole() {
  for (const kind of ["error", "warn"]) {
    const orig = console[kind];
    console[kind] = function (...a) { try { noteError(kind, a); } catch { /* */ } return orig.apply(this, a); };
  }
  window.addEventListener("error", () => { I.uncaught++; });
  window.addEventListener("unhandledrejection", () => { I.uncaught++; });
  _setInterval(() => { errStackBudget = 60; }, 60000);
  errStackBudget = 60;
}

// ─────────────────────────────────────────────────────────────── sockets
function sizeOf(args) {
  if (!I.measureBytes) return 0;
  try {
    let n = 0;
    for (const a of args) {
      if (typeof a === "function") continue;
      if (a instanceof ArrayBuffer) n += a.byteLength;
      else n += JSON.stringify(a)?.length ?? 0;
    }
    return n;
  } catch { return 0; }
}
function sockKey(evt, args) {
  if (evt === "modifyDocument") {
    const r = args[0];
    const type = r?.type ?? r?.documentName ?? "?";
    const action = r?.action ?? "?";
    return `modifyDocument · ${type} ${action}`;
  }
  if (evt === "userActivity") {
    const d = args[1] ?? {};
    return `userActivity · ${Object.keys(d).join("+") || "?"}`;
  }
  return evt;
}
export function attachSocket() {
  const s = game.socket;
  if (!s || s.__ldPatched) return;
  s.__ldPatched = true;
  if (typeof s.onAny === "function") {
    I.support.onAny = true;
    s.onAny((evt, ...args) => {
      const b = sizeOf(args);
      const k = sockKey(evt, args);
      let e = I.sockIn.get(k); if (!e) I.sockIn.set(k, (e = { n: 0, bytes: 0 }));
      e.n++; e.bytes += b;
      I.sockInWin.n++; I.sockInWin.bytes += b;
      if (evt.startsWith("module.")) addOwner(evt.slice(7), { sockIn: 1 });
      if (evt.startsWith("system.")) addOwner(`system:${evt.slice(7)}`, { sockIn: 1 });
    });
  }
  if (typeof s.onAnyOutgoing === "function") {
    s.onAnyOutgoing((evt, ...args) => {
      const b = sizeOf(args);
      const k = sockKey(evt, args);
      let e = I.sockOut.get(k); if (!e) I.sockOut.set(k, (e = { n: 0, bytes: 0 }));
      e.n++; e.bytes += b;
      I.sockOutWin.n++; I.sockOutWin.bytes += b;
      if (evt.startsWith("module.")) addOwner(evt.slice(7), { sockOut: 1 });
    });
  }
  s.on?.("disconnect", () => I.sockDisconnects++);
  s.io?.on?.("reconnect", () => I.sockReconnects++);
}

/** Round trip to the server and back, in ms (the server's own event loop is part of it). */
export function pingServer(timeout = 5000) {
  return new Promise((resolve) => {
    const t = now();
    let done = false;
    const timer = _setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeout);
    try {
      game.socket.emit("time", () => { if (done) return; done = true; clearTimeout(timer); resolve(Math.round(now() - t)); });
    } catch { done = true; clearTimeout(timer); resolve(null); }
  });
}

// ─────────────────────────────────────────────────────────────── window readout / reset
export function frameStats() {
  const f = I.frames;
  const n = Math.min(f.n, f.deltas.length);
  if (!n) return { fps: null, avgMs: null, p95: null, p99: null, max: null, h50: 0, h100: 0, h250: 0 };
  const arr = Array.from(f.deltas.subarray(0, n)).sort((a, b) => a - b);
  const sum = arr.reduce((a, b) => a + b, 0);
  const pct = (p) => arr[Math.min(n - 1, Math.floor(n * p))];
  return {
    fps: Math.round(1000 / (sum / n)), avgMs: +(sum / n).toFixed(1),
    p95: Math.round(pct(0.95)), p99: Math.round(pct(0.99)), max: Math.round(f.max),
    h50: f.hitch50, h100: f.hitch100, h250: f.hitch250,
  };
}

export function resetWindow() {
  const f = I.frames;
  f.n = 0; f.hitch50 = 0; f.hitch100 = 0; f.hitch250 = 0; f.max = 0; f.hiddenMs = 0;
  I.loop.max = 0; I.loop.over100 = 0; I.loop.over500 = 0;
  I.longFrames.count = 0; I.longFrames.blockedMs = 0; I.longFrames.totalMs = 0; I.longFrames.forcedLayoutMs = 0;
  I.ownersWin.clear();
  I.hookCallsWin.clear();
  I.sockInWin = { n: 0, bytes: 0 }; I.sockOutWin = { n: 0, bytes: 0 };
  I.timeoutsWin = 0; I.rafCalls = 0; I.errorsWin = 0; I.warnsWin = 0;
}

export function resetSession() {
  resetWindow();
  I.owners.clear(); I.hookCalls.clear(); I.sockIn.clear(); I.sockOut.clear();
  I.worstFrames.length = 0; I.errorSamples.length = 0; I.uncaught = 0;
  for (const r of I.hookEntries.values()) { r.calls = 0; r.ms = 0; r.max = 0; }
}

// ─────────────────────────────────────────────────────────────── start
let started = false;
export function startInstrumentation({ hooks = true, timers = true, listeners = true, console: con = true } = {}) {
  if (started) return;
  started = true;
  const safe = (f, what) => { try { f(); } catch (e) { console.warn(`${MODULE_ID} | could not start ${what}`, e); } };
  safe(() => _raf(frameLoop), "frame timing");
  safe(loopLag, "stall timer");
  safe(observeLongFrames, "long-frame observer");
  if (hooks) safe(patchHooks, "hook timing");
  if (timers) safe(patchTimers, "timer tracking");
  if (listeners) safe(patchListeners, "listener tracking");
  if (con) safe(patchConsole, "error counting");
}
export { _setInterval, _setTimeout };
