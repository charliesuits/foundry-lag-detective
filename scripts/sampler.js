/**
 * Lag Detective — the periodic snapshot.
 *
 * Every interval (30 s by default) one row is taken of everything that tends to grow during a long
 * session. One counter climbing while the others stay flat names the subsystem that is leaking.
 */
import {
  MODULE_ID, I, frameStats, resetWindow, sweepHooks, hookRegistrations, intervalsByOwner,
  listenersByOwner, totalGlobalListeners, pingServer, _setInterval,
} from "./instrument.js";

export const S = {
  rows: [],            // samples
  events: [],          // { at, min, kind, label }
  regs: [],            // per-sample snapshot of hook registrations / intervals / listeners by owner (for leak blame)
  timer: null,
  every: 30000,
  t0: Date.now(),
  lastSaved: 0,
  maxRows: 2880,       // 24 h at 30 s
};

const n = (f, d = null) => { try { const v = f(); return v === undefined || v === null || Number.isNaN(v) ? d : v; } catch { return d; } };
const MB = (b) => Math.round(b / 1048576);
const minutes = () => +((Date.now() - S.t0) / 60000).toFixed(1);

/** Count display objects under a PIXI container, stopping at a cap. */
function countDisplay(root, cap = 250000) {
  let c = 0;
  const stack = [root];
  while (stack.length && c < cap) {
    const o = stack.pop();
    c++;
    const ch = o?.children;
    if (ch?.length) for (let i = 0; i < ch.length; i++) stack.push(ch[i]);
  }
  return c;
}

function gpuTextures() {
  const r = canvas?.app?.renderer;
  const list = r?.texture?.managedTextures;
  if (!list) return { count: null, mb: null };
  let bytes = 0;
  for (const t of list) {
    if (!t) continue;
    const w = t.realWidth ?? t.width ?? 0, h = t.realHeight ?? t.height ?? 0;
    bytes += w * h * 4 * (t.mipmap ? 1.33 : 1);
  }
  return { count: list.length, mb: MB(bytes) };
}

function three() {
  const L = game.Levels3DPreview;
  const info = L?.renderer?.info;
  if (!info || L._active === false) return {};
  return {
    threeGeo: info.memory?.geometries ?? null,
    threeTex: info.memory?.textures ?? null,
    threeProg: info.programs?.length ?? null,
    threeCalls: info.render?.calls ?? null,
    threeTris: info.render?.triangles ?? null,
    modelCache: n(() => Object.keys(L.helpers?.modelCache ?? {}).length),
  };
}

function windowsOpen() {
  const v2 = n(() => foundry.applications.instances.size, 0);
  const v1 = n(() => Object.keys(ui.windows ?? {}).length, 0);
  return v2 + v1;
}

function domRegion(sel) { return n(() => document.querySelector(sel)?.getElementsByTagName("*").length ?? 0); }

/** Owners in this window's long-frame blame, top 3. */
function topOwners(map, field, k = 3) {
  return [...map.entries()].map(([o, v]) => [o, v[field] ?? 0]).filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, k).map(([o, v]) => `${o} ${Math.round(v)}ms`).join(", ");
}

export async function sample(label = "") {
  const fs = frameStats();
  const secs = Math.max(1, (Date.now() - (S.lastSample ?? S.t0)) / 1000);
  S.lastSample = Date.now();
  const perMin = (x) => Math.round((x / secs) * 60);
  const gpu = gpuTextures();
  const hooksRegistered = n(() => sweepHooks());
  let hookCallsWin = 0, hookMsWin = 0;
  for (const v of I.hookCallsWin.values()) { hookCallsWin += v.calls; hookMsWin += v.ms; }
  const renders = [...I.hookCallsWin.entries()].filter(([k]) => /^render/.test(k)).reduce((a, [, v]) => a + v.calls, 0);
  const refreshes = [...I.hookCallsWin.entries()].filter(([k]) => /^refresh/.test(k)).reduce((a, [, v]) => a + v.calls, 0);
  const docUpdates = [...I.hookCallsWin.entries()].filter(([k]) => /^(create|update|delete)[A-Z]/.test(k)).reduce((a, [, v]) => a + v.calls, 0);
  const rtt = await pingServer(4000);
  const mem = performance.memory;
  const scene = canvas?.scene;
  const cv = canvas?.ready;

  const r = {
    min: minutes(),
    clock: new Date().toLocaleTimeString(),
    note: label,
    hidden: document.hidden ? 1 : 0,
    scene: scene?.name ?? "",
    users: n(() => game.users.filter((u) => u.active).length),
    // smoothness
    fps: fs.fps, frameP95: fs.p95, frameP99: fs.p99, frameMax: fs.max,
    hitches: fs.h100, bigHitches: fs.h250,
    stallMax: Math.round(I.loop.max), stalls: I.loop.over100,
    longFrames: I.longFrames.count, longFrameMs: Math.round(I.longFrames.totalMs), blockedMs: Math.round(I.longFrames.blockedMs),
    layoutMs: Math.round(I.longFrames.forcedLayoutMs),
    topBlame: topOwners(I.ownersWin, "loafMs"),
    // memory
    heapMB: mem ? MB(mem.usedJSHeapSize) : null,
    heapTotalMB: mem ? MB(mem.totalJSHeapSize) : null,
    heapLimitMB: mem ? MB(mem.jsHeapSizeLimit) : null,
    // 2D canvas (PIXI)
    gpuTex: gpu.count, gpuTexMB: gpu.mb,
    pixiCache: n(() => Object.keys(PIXI.utils?.BaseTextureCache ?? {}).length),
    stageObjects: cv ? n(() => countDisplay(canvas.stage)) : null,
    tickerFns: n(() => canvas.app.ticker.count),
    tokens: cv ? n(() => canvas.tokens.placeables.length) : null,
    tiles: cv ? n(() => canvas.tiles.placeables.length) : null,
    walls: cv ? n(() => canvas.walls.placeables.length) : null,
    lights: cv ? n(() => canvas.lighting.placeables.length) : null,
    lightSources: cv ? n(() => canvas.effects.lightSources.size) : null,
    visionSources: cv ? n(() => canvas.effects.visionSources.size) : null,
    // 3D canvas
    ...three(),
    // media + page
    videos: n(() => document.getElementsByTagName("video").length),
    videosPlaying: n(() => [...document.getElementsByTagName("video")].filter((v) => !v.paused).length),
    sounds: n(() => game.audio?.playing?.size ?? null),
    canvases: n(() => document.getElementsByTagName("canvas").length),
    iframes: n(() => document.getElementsByTagName("iframe").length),
    domNodes: n(() => document.getElementsByTagName("*").length),
    sidebarNodes: domRegion("#sidebar"),
    chatNodes: domRegion("#chat-log") ?? domRegion("#chat"),
    windows: windowsOpen(),
    messages: n(() => game.messages.size),
    // modules and wiring
    hooksRegistered,
    hookCalls: perMin(hookCallsWin), hookMs: Math.round(hookMsWin),
    renders: perMin(renders), refreshes: perMin(refreshes), docUpdates: perMin(docUpdates),
    intervals: I.intervals.size,
    timeouts: perMin(I.timeoutsWin),
    rafPerSec: Math.round(I.rafCalls / secs),
    listeners: totalGlobalListeners(),
    seqEffects: n(() => Sequencer.EffectManager.effects.length),
    errors: perMin(I.errorsWin), warnings: perMin(I.warnsWin),
    // network
    pingMs: rtt,
    latencyMs: n(() => Math.round(game.time.averageLatency)),
    sockIn: perMin(I.sockInWin.n), sockOut: perMin(I.sockOutWin.n),
    sockInKB: Math.round((I.sockInWin.bytes / 1024 / secs) * 60), sockOutKB: Math.round((I.sockOutWin.bytes / 1024 / secs) * 60),
    reconnects: I.sockReconnects,
  };
  S.rows.push(r);
  if (S.rows.length > S.maxRows) S.rows.splice(0, S.rows.length - S.maxRows);
  S.regs.push({ min: r.min, hooks: hookRegistrations(), intervals: intervalsByOwner(), listeners: listenersByOwner() });
  if (S.regs.length > 400) S.regs.splice(1, 1);  // keep the first one as the baseline
  resetWindow();
  Hooks.callAll(`${MODULE_ID}.sample`, r);
  return r;
}

export function mark(label, kind = "mark") {
  S.events.push({ at: Date.now(), min: minutes(), kind, label });
  if (S.events.length > 1000) S.events.shift();
  Hooks.callAll(`${MODULE_ID}.event`, S.events.at(-1));
}

export function startSampler(every = 30) {
  S.every = Math.max(5, every) * 1000;
  if (S.timer) clearInterval(S.timer);
  S.timer = _setInterval(() => sample().catch((e) => console.warn(`${MODULE_ID} | sample failed`, e)), S.every);
}

export function restartSession() {
  S.rows.length = 0; S.events.length = 0; S.regs.length = 0;
  S.t0 = Date.now(); S.lastSample = Date.now();
}

/** Automatic event markers, so a climb can be matched to what happened at the table. */
export function watchEvents() {
  Hooks.on("canvasReady", (c) => mark(`Scene: ${c.scene?.name ?? "?"}`, "scene"));
  Hooks.on("combatStart", (c) => mark("Combat started", "combat"));
  Hooks.on("deleteCombat", () => mark("Combat ended", "combat"));
  Hooks.on("userConnected", (u, on) => mark(`${u.name} ${on ? "joined" : "left"}`, "user"));
  Hooks.on("pauseGame", (p) => mark(p ? "Paused" : "Unpaused", "pause"));
  Hooks.on("updateScene", (s, ch) => { if (ch.active) mark(`Activated scene: ${s.name}`, "scene"); });
  document.addEventListener("visibilitychange", () => mark(document.hidden ? "Window hidden / minimised" : "Window visible again", "focus"));
}
