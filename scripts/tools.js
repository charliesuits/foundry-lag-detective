/**
 * Lag Detective — active tools: A/B tests, the 30-second deep scan, polling players, saving reports.
 */
import { MODULE_ID, I, frameStats, _setTimeout } from "./instrument.js";
import { S, sample, mark } from "./sampler.js";
import { blame, suspects, checkup } from "./analysis.js";

const n = (f, d = null) => { try { const v = f(); return v ?? d; } catch { return d; } };
const wait = (ms) => new Promise((r) => _setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────── A/B tests
export const ACTIONS = {
  textures: {
    label: "Free unused textures", icon: "fa-solid fa-broom",
    hint: "Asks the 2D canvas to release images it isn't drawing any more. Harmless.",
    run: () => canvas.app.renderer.textureGC.run(),
    available: () => !!n(() => canvas.app.renderer.textureGC),
  },
  chat: {
    label: "Re-render chat", icon: "fa-solid fa-comments",
    hint: "Rebuilds the chat log from scratch. Harmless.",
    run: () => ui.chat.render(true),
    available: () => !!ui.chat,
  },
  windows: {
    label: "Close all windows", icon: "fa-solid fa-window-restore",
    hint: "Closes every open sheet and dialog (not the sidebar or this window).",
    run: (self) => {
      for (const app of [...foundry.applications.instances.values()]) if (app !== self && app.hasFrame && app.rendered) app.close();
      for (const app of Object.values(ui.windows ?? {})) app.close?.();
    },
    available: () => true,
  },
  canvas: {
    label: "Redraw canvas", icon: "fa-solid fa-map",
    hint: "Tears down and redraws the current scene, as if you switched to it. Takes a few seconds.",
    run: () => canvas.draw(),
    available: () => !!canvas?.scene,
  },
  models3d: {
    label: "Clear the 3D model cache", icon: "fa-solid fa-cube",
    hint: "3D Canvas reloads models as they are needed.",
    run: () => { game.Levels3DPreview.helpers.modelCache = {}; globalThis.ModelDoctor?.clearCache?.(); },
    available: () => !!n(() => game.Levels3DPreview?.helpers),
  },
  sequencer: {
    label: "End all Sequencer effects", icon: "fa-solid fa-wand-sparkles",
    hint: "Stops every running effect for everyone — including persistent ones saved on the scene.", confirm: true,
    run: () => Sequencer.EffectManager.endAllEffects(),
    available: () => !!globalThis.Sequencer?.EffectManager,
  },
};

const COMPARE = ["heapMB", "gpuTexMB", "gpuTex", "stageObjects", "videos", "domNodes", "sidebarNodes", "windows", "threeGeo", "threeTex", "seqEffects", "fps", "frameP95"];

export async function runAction(key, self) {
  const a = ACTIONS[key];
  if (!a) return null;
  const before = await sample(`Before: ${a.label}`);
  mark(`Test: ${a.label}`, "test");
  await a.run(self);
  await wait(key === "canvas" ? 8000 : 5000);
  const after = await sample(`After: ${a.label}`);
  const diff = COMPARE.filter((f) => typeof before[f] === "number" && typeof after[f] === "number")
    .map((f) => ({ f, before: before[f], after: after[f], delta: after[f] - before[f] }));
  return { key, label: a.label, diff };
}

// ─────────────────────────────────────────────────────────────── deep scan
/** Name the region of the page an element belongs to. */
function region(node) {
  let el = node.nodeType === 1 ? node : node.parentElement;
  for (let i = 0; el && i < 14; i++, el = el.parentElement) {
    if (el.classList?.contains("application") || el.classList?.contains("app")) {
      const t = el.querySelector?.(".window-title")?.textContent?.trim();
      if (t) return `Window: ${t.slice(0, 40)}`;
      if (el.id) return `#${el.id}`;
    }
    if (el.id && el.id !== "interface" && el.id !== "ui-left" && el.id !== "ui-right" && el.id !== "ui-middle") {
      const tab = el.id === "sidebar" ? el.querySelector(".tab.active")?.dataset?.tab : null;
      return tab ? `#sidebar (${tab} tab)` : `#${el.id}`;
    }
  }
  return "page";
}

export async function deepScan(seconds = 30, progress = () => {}) {
  const hookBefore = new Map([...I.hookCalls.entries()].map(([k, v]) => [k, { ...v }]));
  const entryBefore = new Map([...I.hookEntries.entries()].map(([k, v]) => [k, v.ms]));
  const sockBefore = new Map([...I.sockIn.entries()].map(([k, v]) => [k, v.n]));
  const ownersBefore = new Map([...I.owners.entries()].map(([k, v]) => [k, { ...v }]));
  const framesBefore = I.worstFrames.length;
  const muts = new Map();
  let total = 0;
  const mine = (node) => { const el = node.nodeType === 1 ? node : node.parentElement; return !!el?.closest?.("#lag-detective-hud, #lag-detective"); };
  const mo = new MutationObserver((list) => {
    for (const m of list) {
      if (mine(m.target)) continue;
      total++;
      const k = region(m.target);
      const e = muts.get(k) ?? { n: 0, attr: 0, text: 0, nodes: 0 };
      e.n++;
      if (m.type === "attributes") e.attr++; else if (m.type === "characterData") e.text++; else e.nodes += m.addedNodes.length + m.removedNodes.length;
      muts.set(k, e);
    }
  });
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  mark(`Deep scan started (${seconds}s)`, "scan");
  const t0 = performance.now();
  const f0 = { ...frameStats() };
  for (let s = 0; s < seconds; s++) { await wait(1000); progress(s + 1, seconds); }
  mo.disconnect();
  const secs = (performance.now() - t0) / 1000;
  const f1 = frameStats();

  const hooks = [...I.hookCalls.entries()].map(([k, v]) => {
    const b = hookBefore.get(k) ?? { calls: 0, ms: 0 };
    return { hook: k, calls: v.calls - b.calls, ms: v.ms - b.ms };
  }).filter((x) => x.calls > 0 && !x.hook.startsWith(MODULE_ID)).sort((a, b) => b.ms - a.ms || b.calls - a.calls).slice(0, 20);
  const callbacks = [...I.hookEntries.entries()].map(([id, r]) => ({ ...r, ms: r.ms - (entryBefore.get(id) ?? 0) }))
    .filter((r) => r.ms > 0.5).sort((a, b) => b.ms - a.ms).slice(0, 20);
  const sockets = [...I.sockIn.entries()].map(([k, v]) => ({ event: k, n: v.n - (sockBefore.get(k) ?? 0) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 12);
  const owners = [...I.owners.entries()].map(([o, v]) => {
    const b = ownersBefore.get(o) ?? {};
    return { owner: o, slowMs: (v.loafMs ?? 0) - (b.loafMs ?? 0), layoutMs: (v.layoutMs ?? 0) - (b.layoutMs ?? 0), hookMs: (v.hookMs ?? 0) - (b.hookMs ?? 0), timerMs: (v.intervalMs ?? 0) - (b.intervalMs ?? 0) };
  }).map((x) => ({ ...x, total: x.slowMs + x.hookMs + x.timerMs })).filter((x) => x.total > 1 && x.owner !== MODULE_ID).sort((a, b) => b.total - a.total).slice(0, 12);
  const regions = [...muts.entries()].map(([k, v]) => ({ region: k, perSec: v.n / secs, ...v })).sort((a, b) => b.n - a.n).slice(0, 12);
  const report = {
    at: new Date().toLocaleTimeString(), seconds: Math.round(secs),
    frames: f1, mutationsPerSec: total / secs, regions, hooks, callbacks, sockets, owners,
    slowFrames: I.worstFrames.slice(framesBefore),
  };
  mark("Deep scan finished", "scan");
  S.lastScan = report;
  return report;
}

// ─────────────────────────────────────────────────────────────── players
const pending = new Map();

export function summary() {
  const r = S.rows.at(-1) ?? {};
  const fs = frameStats();
  let gpu = null;
  try {
    const gl = canvas.app.renderer.gl;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    gpu = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  } catch { /* */ }
  const top = blame().filter((b) => b.owner !== "core" && b.owner !== "unknown").slice(0, 3).map((b) => `${b.title} ${Math.round(b.cost)}ms/min`);
  return {
    user: game.user.name, userId: game.user.id, isGM: game.user.isGM,
    fps: fs.fps ?? r.fps, frameP95: fs.p95 ?? r.frameP95, heapMB: r.heapMB, heapLimitMB: r.heapLimitMB,
    gpuTexMB: r.gpuTexMB, pingMs: r.pingMs, domNodes: r.domNodes, windows: r.windows,
    gpu, app: /Electron/i.test(navigator.userAgent) ? "Foundry app" : (navigator.userAgentData?.brands?.find((b) => !/Not.A.Brand|Chromium/i.test(b.brand))?.brand ?? "Browser"),
    hidden: document.hidden, uptimeMin: Math.round((Date.now() - I.started) / 60000),
    perfMode: n(() => canvas.performance.mode), dpr: window.devicePixelRatio,
    cores: navigator.hardwareConcurrency, topModules: top,
    suspects: suspects().filter((s) => s.sev !== "ok").slice(0, 3).map((s) => `${s.sev}: ${s.title}`),
  };
}

export function registerSocket() {
  game.socket.on(`module.${MODULE_ID}`, async (msg) => {
    if (msg?.t === "poll" && !game.user.isGM) {
      if (!game.settings.get(MODULE_ID, "answerPolls")) return;
      game.socket.emit(`module.${MODULE_ID}`, { t: "report", id: msg.id, to: msg.from, data: summary() });
    } else if (msg?.t === "report" && msg.to === game.user.id) {
      pending.get(msg.id)?.push(msg.data);
    }
  });
}

export async function pollPlayers(timeout = 4000) {
  const id = foundry.utils.randomID();
  const got = [summary()];
  pending.set(id, got);
  game.socket.emit(`module.${MODULE_ID}`, { t: "poll", id, from: game.user.id });
  await wait(timeout);
  pending.delete(id);
  const answered = new Set(got.map((g) => g.userId));
  const silent = game.users.filter((u) => u.active && !answered.has(u.id)).map((u) => u.name);
  return { at: new Date().toLocaleTimeString(), reports: got, silent };
}

// ─────────────────────────────────────────────────────────────── reports
let lastCheckup = null;
export async function getCheckup(force = false) {
  if (force || !lastCheckup) lastCheckup = await checkup();
  return lastCheckup;
}

export async function fullReport() {
  const top = (m, k, f) => [...m.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b[f] - a[f]).slice(0, k);
  return {
    generated: new Date().toISOString(),
    tool: `${MODULE_ID} ${game.modules.get(MODULE_ID)?.version}`,
    world: { id: game.world.id, title: game.world.title }, user: game.user.name, isGM: game.user.isGM,
    foundry: game.version, system: `${game.system.id} ${game.system.version}`,
    client: navigator.userAgent, support: I.support,
    sessionStarted: new Date(S.t0).toISOString(),
    modules: game.modules.filter((m) => m.active).map((m) => `${m.id}@${m.version}`),
    suspects: suspects(), checkup: await getCheckup(),
    blame: blame().slice(0, 60),
    hookCallbacks: [...I.hookEntries.values()].filter((r) => r.ms > 1).sort((a, b) => b.ms - a.ms).slice(0, 100),
    hooksFired: top(I.hookCalls, 100, "calls"),
    socketIn: top(I.sockIn, 50, "n"), socketOut: top(I.sockOut, 50, "n"),
    intervals: [...I.intervals.values()],
    listeners: Object.fromEntries(I.globalListeners),
    slowFrames: I.worstFrames, errors: I.errorSamples,
    lastScan: S.lastScan ?? null,
    events: S.events, samples: S.rows,
  };
}

export function toCSV(rows = S.rows) {
  if (!rows.length) return "";
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => (v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  return [keys.join(","), ...rows.map((r) => keys.map((k) => cell(r[k])).join(","))].join("\n");
}

function stamp(d = new Date()) { return d.toISOString().slice(0, 16).replace(/[:T]/g, "-"); }

export function download(text, name, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  _setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export async function downloadReport() { download(JSON.stringify(await fullReport(), null, 1), `lag-report-${game.world.id}-${stamp()}.json`, "application/json"); }
export function downloadCSV() { download(toCSV(), `lag-samples-${game.world.id}-${stamp()}.csv`, "text/csv"); }

/** Save the report into the Foundry Data folder so it survives a crash. GM only (players usually can't upload). */
export async function saveToData({ notify = false } = {}) {
  if (!game.user.isGM && !game.user.can?.("FILES_UPLOAD")) return null;
  const FP = foundry.applications.apps.FilePicker.implementation;
  const dir = `${MODULE_ID}-data`;
  const sub = `${dir}/${game.world.id}`;
  const src = globalThis.ForgeVTT?.usingTheForge ? "forgevtt" : "data";
  for (const d of [dir, sub]) { try { await FP.createDirectory(src, d, {}); } catch { /* exists */ } }
  const name = `session-${stamp(new Date(S.t0))}.json`;
  const file = new File([JSON.stringify(await fullReport())], name, { type: "application/json" });
  try { await FP.upload(src, sub, file, {}, { notify: false }); }
  catch (e) { console.warn("Lag Detective | couldn't save the report to the server", e); return null; }
  S.lastSaved = Date.now();
  if (notify) ui.notifications.info(`Lag report saved to Data/${sub}/${name}`);
  return `${sub}/${name}`;
}
