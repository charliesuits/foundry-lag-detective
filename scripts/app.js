/**
 * Lag Detective — the main window.
 */
import { MODULE_ID, I, frameStats } from "./instrument.js";
import { S, sample, mark, restartSession } from "./sampler.js";
import { FIELDS, trend, suspects, blame, label } from "./analysis.js";
import { ACTIONS, runAction, deepScan, pollPlayers, getCheckup, downloadReport, downloadCSV, saveToData } from "./tools.js";
import { resetSession } from "./instrument.js";

const HAM = foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2);
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const fmt = (x, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? "—" : Number(x).toLocaleString(undefined, { maximumFractionDigits: d }));
const SEV = { high: ["Serious", "fa-circle-exclamation"], medium: ["Worth fixing", "fa-triangle-exclamation"], low: ["Worth knowing", "fa-circle-info"], ok: ["Fine", "fa-circle-check"] };

const TABS = [
  ["overview", "Overview", "fa-solid fa-stethoscope"],
  ["timeline", "Timeline", "fa-solid fa-chart-line"],
  ["modules", "Modules", "fa-solid fa-puzzle-piece"],
  ["activity", "Activity", "fa-solid fa-bolt"],
  ["frames", "Slow frames", "fa-solid fa-hourglass-half"],
  ["players", "Players", "fa-solid fa-users"],
  ["checkup", "Checkup", "fa-solid fa-list-check"],
  ["tools", "Tools", "fa-solid fa-toolbox"],
];

const CHARTS = [
  ["How smooth it feels", ["fps", "frameP95", "stallMax", "longFrameMs"]],
  ["Memory", ["heapMB", "gpuTexMB", "gpuTex", "stageObjects", "threeGeo", "threeTex", "threeTris"]],
  ["The page", ["domNodes", "sidebarNodes", "chatNodes", "windows", "videos", "canvases"]],
  ["Module wiring", ["hooksRegistered", "hookMs", "intervals", "listeners", "tickerFns", "seqEffects", "errors"]],
  ["Activity", ["renders", "refreshes", "docUpdates"]],
  ["Server and network", ["pingMs", "latencyMs", "sockIn", "sockOut", "sockInKB"]],
];

export class LagDetectiveApp extends HAM {
  static DEFAULT_OPTIONS = {
    id: "lag-detective",
    classes: ["lag-detective"],
    tag: "div",
    window: { title: "Lag Detective", icon: "fa-solid fa-magnifying-glass-chart", resizable: true },
    position: { width: 980, height: 720 },
  };
  static PARTS = { content: { template: `modules/${MODULE_ID}/templates/host.hbs` } };

  static open(tab) {
    const cur = foundry.applications.instances.get("lag-detective");
    if (cur) { if (tab) cur.show(tab); cur.bringToFront(); if (cur.minimized) cur.maximize(); return cur; }
    const app = new LagDetectiveApp();
    if (tab) app.tab = tab;
    app.render({ force: true });
    return app;
  }

  constructor(options = {}) {
    super(options);
    this.tab = "overview";
    this.sort = { key: "cost", dir: -1 };
    this.lastAction = null;
    this.busy = false;
    this._hook = null;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const host = this.element.querySelector(".ld-host");
    if (!host.firstElementChild) this.buildShell(host);
    this.draw();
    if (!this._hook) this._hook = Hooks.on(`${MODULE_ID}.sample`, () => this.onSample());
  }

  _onClose(options) {
    super._onClose?.(options);
    if (this._hook) Hooks.off(`${MODULE_ID}.sample`, this._hook);
    this._hook = null;
  }

  buildShell(host) {
    host.innerHTML = `<div class="ld">
      <nav class="ld-tabs">${TABS.map(([k, l, i]) => `<a data-tab="${k}"><i class="${i}"></i><span>${l}</span></a>`).join("")}
        <div class="ld-status"></div></nav>
      <section class="ld-body"></section>
    </div>`;
    this.el = { root: host.firstElementChild, body: host.querySelector(".ld-body"), status: host.querySelector(".ld-status") };
    host.querySelector(".ld-tabs").addEventListener("click", (e) => {
      const a = e.target.closest("[data-tab]");
      if (a) this.show(a.dataset.tab);
    });
    this.el.body.addEventListener("click", (e) => this.onClick(e));
  }

  show(tab) { this.tab = tab; this.el.body.scrollTop = 0; this.draw(); }

  onSample() {
    if (!this.rendered || this.busy) return;
    if (["overview", "timeline", "modules", "activity", "frames"].includes(this.tab)) this.draw(true);
    else this.drawStatus();
  }

  drawStatus() {
    const mins = Math.round((Date.now() - S.t0) / 60000);
    const saved = S.lastSaved ? ` · saved ${new Date(S.lastSaved).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
    this.el.status.innerHTML = `<i class="fa-solid fa-circle ld-rec"></i> ${S.rows.length} samples · ${mins} min${saved}`;
    this.el.status.dataset.tooltip = `One sample every ${S.every / 1000} s since ${new Date(S.t0).toLocaleTimeString()}. Leaks show up after 15–20 minutes of samples.`;
  }

  draw(keepScroll = false) {
    const top = this.el.body.scrollTop;
    for (const a of this.el.root.querySelectorAll(".ld-tabs [data-tab]")) a.classList.toggle("on", a.dataset.tab === this.tab);
    this.drawStatus();
    const fn = this[`tab_${this.tab}`];
    const html = fn ? fn.call(this) : "";
    if (typeof html === "string") this.el.body.innerHTML = html;
    if (keepScroll) this.el.body.scrollTop = top;
  }

  // ─────────────────────────────────────────── overview
  tab_overview() {
    const r = S.rows.at(-1) ?? {};
    const fs = frameStats();
    const fps = fs.fps ?? r.fps;
    const card = (lbl, val, unit, state, tip) => `<div class="ld-card ${state}" data-tooltip="${esc(tip)}"><div class="ld-card-v">${val}<small>${unit}</small></div><div class="ld-card-l">${lbl}</div></div>`;
    const st = (v, warn, bad, low = false) => (v === null || v === undefined ? "" : low ? (v < bad ? "bad" : v < warn ? "warn" : "good") : (v > bad ? "bad" : v > warn ? "warn" : "good"));
    const heapPct = r.heapMB && r.heapLimitMB ? (r.heapMB / r.heapLimitMB) * 100 : null;
    const cards = [
      card("Frames per second", fmt(fps), "", st(fps, 45, 28, true), "Averaged over the last few seconds. 60 is smooth; under 30 feels sluggish."),
      card("Slow-frame time", fmt(fs.p95 ?? r.frameP95), "ms", st(fs.p95 ?? r.frameP95, 33, 70), "The slowest 5% of frames. A smooth frame is 17 ms; over 50 ms is a visible stutter."),
      card("Longest freeze", fmt(r.stallMax), "ms", st(r.stallMax, 200, 700), "The longest time the page couldn't respond at all, in the last sample."),
      card("JS memory", fmt(r.heapMB), "MB", heapPct === null ? "" : st(heapPct, 55, 80), heapPct ? `${Math.round(heapPct)}% of the ${fmt(r.heapLimitMB)} MB the browser allows.` : "Not available in this browser."),
      card("GPU images", fmt(r.gpuTexMB), "MB", st(r.gpuTexMB, 800, 1800), "Images and video frames held on the graphics card by the 2D canvas."),
      card("Server round trip", fmt(r.pingMs), "ms", st(r.pingMs, 250, 800), "How long the server takes to answer. Slow here means the server or network, not this tab."),
    ].join("");
    const all = suspects();
    const serious = all.filter((s) => s.sev === "high" || s.sev === "medium");
    const minor = all.filter((s) => s.sev === "low");
    const span = S.rows.length > 1 ? S.rows.at(-1).min - S.rows[0].min : 0;
    const mins = Math.max(span, (Date.now() - S.t0) / 60000);
    const sus = (s) => `<div class="ld-sus ${s.sev}"><div class="ld-sus-h"><i class="fa-solid ${SEV[s.sev][1]}"></i><b>${esc(s.title)}</b><em>${SEV[s.sev][0]}</em></div>
      <p>${esc(s.detail)}</p>${s.next ? `<p class="ld-next"><i class="fa-solid fa-arrow-right"></i> ${esc(s.next)}</p>` : ""}</div>`;
    let body = serious.map(sus).join("");
    if (!serious.length) body = `<div class="ld-empty"><i class="fa-solid fa-circle-check"></i> ${mins < 15
      ? `Nothing stands out yet. Slow-downs that build over a session need 15–20 minutes of samples before they show — keep this running and play as normal.`
      : "Nothing stands out. If it still feels laggy, press <b>Ctrl+Shift+M</b> the moment it happens to mark it, then check the Slow frames tab."}</div>`;
    const warm = mins < 15 ? `<div class="ld-note"><i class="fa-solid fa-hourglass-start"></i> ${Math.round(mins)} of ~15 minutes collected for leak detection.</div>` : "";
    const events = S.events.slice(-6).reverse().map((e) => `<li><span>${new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> ${esc(e.label)}</li>`).join("");
    return `<div class="ld-cards">${cards}</div>
      <div class="ld-cols"><div>
        <h3>Suspects</h3>${warm}${body}
        ${minor.length ? `<details class="ld-minor"><summary>${minor.length} smaller thing${minor.length === 1 ? "" : "s"}</summary>${minor.map(sus).join("")}</details>` : ""}
      </div><aside>
        <h3>Recent events</h3><ul class="ld-events">${events || "<li>None yet.</li>"}</ul>
        <button type="button" data-do="mark"><i class="fa-solid fa-flag"></i> Mark "lag felt now"</button>
        <button type="button" data-do="scan"><i class="fa-solid fa-magnifying-glass"></i> Deep scan (30 s)</button>
        <p class="ld-hint">Marks show on the Timeline, so a spike can be matched to what was happening. Shortcut: Ctrl+Shift+M.</p>
      </aside></div>`;
  }

  // ─────────────────────────────────────────── timeline
  chart(field) {
    const rows = S.rows.filter((r) => typeof r[field] === "number");
    if (rows.length < 2) return "";
    const W = 600, H = 70, pad = 3;
    const xs = rows.map((r) => r.min), ys = rows.map((r) => r[field]);
    const x0 = xs[0], x1 = Math.max(xs.at(-1), x0 + 1);
    let lo = Math.min(...ys), hi = Math.max(...ys);
    const minRange = Math.max(1, Math.abs(hi) * 0.08);   // small jitter should look flat, not like a zigzag
    if (hi - lo < minRange) { const mid = (hi + lo) / 2; lo = Math.max(0, mid - minRange / 2); hi = lo + minRange; }
    const X = (x) => pad + ((x - x0) / (x1 - x0)) * (W - pad * 2);
    const Y = (y) => H - pad - ((y - lo) / (hi - lo)) * (H - pad * 2);
    const pts = rows.map((r) => `${X(r.min).toFixed(1)},${Y(r[field]).toFixed(1)}`).join(" ");
    const marks = S.events.filter((e) => e.min >= x0 && e.min <= x1).map((e) =>
      `<line class="ev ${e.kind}" x1="${X(e.min).toFixed(1)}" x2="${X(e.min).toFixed(1)}" y1="0" y2="${H}"><title>${esc(`${new Date(e.at).toLocaleTimeString()} — ${e.label}`)}</title></line>`).join("");
    const dots = rows.length <= 240 ? rows.map((r) => `<circle cx="${X(r.min).toFixed(1)}" cy="${Y(r[field]).toFixed(1)}" r="5" class="hit"><title>${esc(`${r.clock}: ${fmt(r[field], 1)} ${FIELDS[field]?.unit ?? ""}${r.note ? ` — ${r.note}` : ""}`)}</title></circle>`).join("") : "";
    const t = trend(field);
    const worse = FIELDS[field]?.good === "high" ? t?.slope < 0 : t?.slope > 0;
    const tr = t && t.r2 > 0.55 && Math.abs(t.slope) > 0 ? `<span class="ld-trend ${worse ? "up" : "down"}" data-tooltip="Straight-line fit over the session (fit quality ${Math.round(t.r2 * 100)}%)">${t.slope > 0 ? "▲" : "▼"} ${fmt(Math.abs(t.slope), Math.abs(t.slope) < 10 ? 1 : 0)}/h</span>` : "";
    const f = FIELDS[field] ?? { label: field, unit: "" };
    return `<div class="ld-chart"><div class="ld-chart-h"><span>${esc(f.label)}</span><b>${fmt(ys.at(-1), 1)} <small>${f.unit}</small></b>${tr}</div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${marks}<polyline points="${pts}"/>${dots}</svg>
      <div class="ld-chart-f"><span>${fmt(lo, 1)}–${fmt(hi, 1)}</span></div></div>`;
  }

  tab_timeline() {
    if (S.rows.length < 2) return `<div class="ld-empty">The timeline fills in as samples arrive (one every ${S.every / 1000} s).</div>`;
    const legend = `<div class="ld-legend"><span class="ev scene"></span> scene <span class="ev combat"></span> combat <span class="ev user"></span> player joined/left <span class="ev mark"></span> your marks <span class="ev test"></span> tests</div>`;
    return legend + CHARTS.map(([title, fields]) => {
      const charts = fields.map((f) => this.chart(f)).join("");
      return charts ? `<h3>${title}</h3><div class="ld-charts">${charts}</div>` : "";
    }).join("");
  }

  // ─────────────────────────────────────────── modules
  tab_modules() {
    const rows = blame();
    const { key, dir } = this.sort;
    rows.sort((a, b) => ((a[key] ?? 0) < (b[key] ?? 0) ? -1 : (a[key] ?? 0) > (b[key] ?? 0) ? 1 : 0) * dir);
    const mins = Math.max(1, (Date.now() - I.started) / 60000);
    const th = (k, l, tip) => `<th data-sort="${k}" data-tooltip="${esc(tip)}" class="${key === k ? "on" : ""}">${l}${key === k ? (dir < 0 ? " ▾" : " ▴") : ""}</th>`;
    const grow = (v, g) => `${fmt(v)}${g > 0 ? ` <em class="grow">+${fmt(g)}</em>` : ""}`;
    const cls = (v, w, b) => (v > b ? "bad" : v > w ? "warn" : "");
    return `<p class="ld-hint">Measured over ${fmt(mins)} minutes on this client. <b>Main thread</b> = time in frames over 50 ms, charged to the script that ran; <b>Hooks</b> = time inside that module's hook callbacks; <b>+N</b> = grown since the session started (a steady rise is a leak). Click a heading to sort.</p>
      <table class="ld-table ld-mod"><thead><tr>
        ${th("title", "Module", "Module, system or Foundry core")}
        ${th("cost", "Total ms/min", "Main thread + hooks + timers, per minute")}
        ${th("slowMs", "Main thread", "ms per minute in slow frames (Long Animation Frames)")}
        ${th("layoutMs", "Forced layout", "ms per minute this module made the page recalculate layout mid-script")}
        ${th("hookMs", "Hooks", "ms per minute inside its hook callbacks")}
        ${th("hookCalls", "Hook calls", "hook callbacks run per minute")}
        ${th("timerMs", "Timers", "ms per minute inside its setInterval callbacks")}
        ${th("regGrow", "Hook regs", "callbacks registered now (+ growth)")}
        ${th("intGrow", "Intervals", "repeating timers running now (+ growth)")}
        ${th("lisGrow", "Listeners", "window/document listeners now (+ growth)")}
        ${th("errors", "Errors", "console errors / warnings attributed to it")}
        ${th("sock", "Socket", "its own socket messages per minute")}
      </tr></thead><tbody>
      ${rows.slice(0, 80).map((b) => `<tr class="${b.owner === "core" ? "core" : ""}">
        <td data-tooltip="${esc(b.owner)}">${esc(b.title)}</td>
        <td class="n ${cls(b.cost, 150, 500)}"><b>${fmt(b.cost)}</b></td>
        <td class="n">${fmt(b.slowMs)}</td><td class="n ${cls(b.layoutMs, 20, 100)}">${fmt(b.layoutMs)}</td>
        <td class="n">${fmt(b.hookMs, 1)}</td><td class="n">${fmt(b.hookCalls)}</td><td class="n">${fmt(b.timerMs, 1)}</td>
        <td class="n ${b.regGrow > 20 ? "bad" : ""}">${grow(b.regs, b.regGrow)}</td>
        <td class="n ${b.intGrow > 2 ? "bad" : ""}">${grow(b.intervals, b.intGrow)}</td>
        <td class="n ${b.lisGrow > 10 ? "bad" : ""}">${grow(b.listeners, b.lisGrow)}</td>
        <td class="n">${b.errors || b.warns ? `${fmt(b.errors)} / ${fmt(b.warns)}` : ""}</td>
        <td class="n">${b.sock ? fmt(b.sock, 1) : ""}</td></tr>`).join("")}
      </tbody></table>`;
  }

  // ─────────────────────────────────────────── activity
  tab_activity() {
    const mins = Math.max(1, (Date.now() - I.started) / 60000);
    const hooksFired = [...I.hookCalls.entries()].filter(([k]) => !k.startsWith(MODULE_ID)).map(([k, v]) => ({ k, ...v })).sort((a, b) => b.calls - a.calls).slice(0, 25);
    // identical callbacks (same module, hook and function) are grouped — many copies of one is itself a leak
    const groups = new Map();
    for (const r of I.hookEntries.values()) {
      if (!r.calls || r.owner === MODULE_ID) continue;
      const k = `${r.owner}|${r.hook}|${r.name}`;
      const g = groups.get(k) ?? { owner: r.owner, hook: r.hook, name: r.name, copies: 0, calls: 0, ms: 0, max: 0 };
      g.copies++; g.calls += r.calls; g.ms += r.ms; g.max = Math.max(g.max, r.max);
      groups.set(k, g);
    }
    const callbacks = [...groups.values()].sort((a, b) => b.ms - a.ms).slice(0, 25);
    const sock = (m) => [...m.entries()].map(([k, v]) => ({ k, ...v })).sort((a, b) => b.n - a.n).slice(0, 15);
    const ints = {};
    for (const v of I.intervals.values()) (ints[v.owner] ??= []).push(v.delay);
    const tbl = (head, rows) => `<table class="ld-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${head.length}">Nothing yet.</td></tr>`}</tbody></table>`;
    return `<div class="ld-grid2">
      <div><h3>Busiest hooks <small>fired per minute</small></h3>
        ${tbl(["Hook", "/min", "ms total"], hooksFired.map((h) => `<tr><td>${esc(h.k)}</td><td class="n">${fmt(h.calls / mins, 1)}</td><td class="n">${fmt(h.ms)}</td></tr>`))}</div>
      <div><h3>Slowest hook callbacks <small>whole session</small></h3>
        ${tbl(["Module", "Hook · function", "calls", "ms", "worst"], callbacks.map((c) => `<tr><td>${esc(label(c.owner))}</td><td>${esc(c.hook)} · <i>${esc(c.name)}</i>${c.copies > 1 ? ` <em class="grow" data-tooltip="The same callback is registered ${c.copies} times">×${c.copies} copies</em>` : ""}</td><td class="n">${fmt(c.calls)}</td><td class="n">${fmt(c.ms)}</td><td class="n">${fmt(c.max, 1)}</td></tr>`))}</div>
      <div><h3>Socket in <small>from the server</small></h3>
        ${I.support.onAny ? tbl(["Event", "/min", "KB"], sock(I.sockIn).map((s) => `<tr><td>${esc(s.k)}</td><td class="n">${fmt(s.n / mins, 1)}</td><td class="n">${fmt(s.bytes / 1024)}</td></tr>`)) : `<p class="ld-hint">Socket counting isn't available on this Foundry version.</p>`}</div>
      <div><h3>Socket out <small>to the server</small></h3>
        ${tbl(["Event", "/min", "KB"], sock(I.sockOut).map((s) => `<tr><td>${esc(s.k)}</td><td class="n">${fmt(s.n / mins, 1)}</td><td class="n">${fmt(s.bytes / 1024)}</td></tr>`))}</div>
      <div><h3>Repeating timers <small>running now</small></h3>
        ${tbl(["Owner", "count", "every"], Object.entries(ints).sort((a, b) => b[1].length - a[1].length).map(([o, d]) => `<tr><td>${esc(label(o))}</td><td class="n">${d.length}</td><td>${[...new Set(d)].slice(0, 5).map((x) => (x >= 1000 ? `${x / 1000}s` : `${x}ms`)).join(", ")}</td></tr>`))}</div>
      <div><h3>Errors and warnings <small>most recent</small></h3>
        ${tbl(["Module", "Message", "×"], [...I.errorSamples].sort((a, b) => b.last - a.last).slice(0, 15).map((e) => `<tr class="${e.kind}"><td>${esc(label(e.owner))}</td><td class="msg">${esc(e.msg)}</td><td class="n">${fmt(e.n)}</td></tr>`))}</div>
    </div>`;
  }

  // ─────────────────────────────────────────── slow frames
  tab_frames() {
    if (!I.support.loaf) return `<div class="ld-empty">This browser doesn't report Long Animation Frames, so individual slow frames can't be broken down. Chrome/Edge 123+ or a current Foundry desktop app can.<br>Frame rate, freezes and hook timing still work.</div>`;
    const list = [...I.worstFrames].reverse();
    if (!list.length) return `<div class="ld-empty"><i class="fa-solid fa-circle-check"></i> No frames over 100 ms yet.</div>`;
    return `<p class="ld-hint">Every frame over 100 ms, newest first, with the scripts that ran in it. <b>Forced layout</b> means a script read the page's size or position after changing it, forcing the browser to recalculate layout on the spot.</p>
      ${list.map((f) => `<div class="ld-frame"><div class="ld-frame-h"><b>${fmt(f.ms)} ms</b><span>${new Date(f.at).toLocaleTimeString()}</span>
        <span class="ld-bar"><i style="width:${Math.min(100, (f.scriptMs / f.ms) * 100)}%" class="s" data-tooltip="Scripts ${f.scriptMs} ms"></i><i style="width:${Math.min(100, (f.renderMs / f.ms) * 100)}%" class="r" data-tooltip="Style, layout and paint ${f.renderMs} ms"></i></span>
        <em>scripts ${fmt(f.scriptMs)} · layout/paint ${fmt(f.renderMs)}</em></div>
        ${f.scripts.length ? `<table class="ld-table"><tbody>${f.scripts.map((s) => `<tr><td>${esc(label(s.owner))}</td><td class="n">${fmt(s.ms)} ms</td><td class="n">${s.layoutMs ? `${fmt(s.layoutMs)} layout` : ""}</td><td class="fn">${esc(s.fn || "(anonymous)")}<small>${esc(s.invoker)}</small></td><td class="url">${esc(s.url)}</td></tr>`).join("")}</tbody></table>`
        : `<p class="ld-hint">No single script over 5 ms — this frame was spent on drawing, style or layout, or in the browser itself.</p>`}</div>`).join("")}`;
  }

  // ─────────────────────────────────────────── players
  tab_players() {
    const p = this.poll;
    const intro = `<p class="ld-hint">Asks every connected client for its own readings: frame rate, memory, graphics card and its top suspects. Players need Lag Detective enabled (it's the same module) and the world setting "Players answer lag checks" on.</p>
      <button type="button" data-do="poll" ${game.user.isGM ? "" : "disabled"}><i class="fa-solid fa-satellite-dish"></i> Check all players</button>`;
    if (!p) return intro;
    const row = (d) => `<tr class="${d.hidden ? "dim" : ""}"><td><b>${esc(d.user)}</b>${d.isGM ? " <em>GM</em>" : ""}${d.hidden ? " <em>tab hidden</em>" : ""}</td>
      <td class="n ${d.fps < 30 ? "bad" : d.fps < 45 ? "warn" : ""}">${fmt(d.fps)}</td><td class="n ${d.frameP95 > 70 ? "bad" : ""}">${fmt(d.frameP95)}</td>
      <td class="n">${fmt(d.heapMB)}${d.heapLimitMB ? `<small>/${fmt(d.heapLimitMB)}</small>` : ""}</td><td class="n">${fmt(d.gpuTexMB)}</td><td class="n">${fmt(d.pingMs)}</td>
      <td class="gpu ${/swiftshader|llvmpipe|software|basic render/i.test(d.gpu ?? "") ? "bad" : ""}">${esc((d.gpu ?? "?").replace(/^ANGLE \(|\)$/g, "").slice(0, 60))}</td>
      <td>${esc(d.app)}${d.dpr > 1 ? ` · ${d.dpr}×` : ""}</td><td class="n">${fmt(d.uptimeMin)}m</td>
      <td class="sm">${(d.topModules ?? []).map(esc).join("<br>")}${(d.suspects ?? []).length ? `<br><i>${d.suspects.map(esc).join("<br>")}</i>` : ""}</td></tr>`;
    return `${intro}<p class="ld-hint">Checked at ${p.at}.${p.silent.length ? ` No answer from: ${p.silent.map(esc).join(", ")} (module not active for them, or setting off).` : ""}</p>
      <table class="ld-table ld-players"><thead><tr><th>User</th><th>FPS</th><th>Slow frame</th><th>Memory MB</th><th>GPU MB</th><th>Ping</th><th>Graphics</th><th>Client</th><th>Up</th><th>Top modules / suspects</th></tr></thead>
      <tbody>${p.reports.map(row).join("")}</tbody></table>`;
  }

  // ─────────────────────────────────────────── checkup
  tab_checkup() {
    if (!this.check) { getCheckup().then((c) => { this.check = c; if (this.tab === "checkup") this.draw(); }); return `<div class="ld-empty"><i class="fa-solid fa-spinner fa-spin"></i> Checking…</div>`; }
    const groups = {};
    for (const c of this.check) (groups[c.group] ??= []).push(c);
    return `<button type="button" data-do="recheck"><i class="fa-solid fa-rotate"></i> Run the checkup again</button>
      ${Object.entries(groups).map(([g, list]) => `<h3>${esc(g)}</h3>${list.map((c) => `<div class="ld-chk ${c.sev}"><i class="fa-solid ${SEV[c.sev][1]}"></i><div><b>${esc(c.title)}</b>${c.detail ? `<p>${esc(c.detail)}</p>` : ""}${c.fix ? `<p class="ld-next"><i class="fa-solid fa-arrow-right"></i> ${esc(c.fix)}</p>` : ""}</div></div>`).join("")}`).join("")}`;
  }

  // ─────────────────────────────────────────── tools
  tab_tools() {
    const la = this.lastAction;
    const scan = S.lastScan;
    const actions = Object.entries(ACTIONS).filter(([, a]) => a.available()).map(([k, a]) => `<div class="ld-act"><button type="button" data-act="${k}"><i class="${a.icon}"></i> ${a.label}</button><span>${esc(a.hint)}</span></div>`).join("");
    const diff = la ? `<h4>Result: ${esc(la.label)}</h4><table class="ld-table ld-diff"><thead><tr><th></th><th>Before</th><th>After</th><th>Change</th></tr></thead><tbody>
      ${la.diff.map((d) => `<tr><td>${esc(FIELDS[d.f]?.label ?? d.f)}</td><td class="n">${fmt(d.before)}</td><td class="n">${fmt(d.after)}</td><td class="n ${d.delta < 0 ? "good" : d.delta > 0 ? "bad" : ""}">${d.delta > 0 ? "+" : ""}${fmt(d.delta)}</td></tr>`).join("")}
      </tbody></table><p class="ld-hint">A big drop means that part was holding the weight. JavaScript memory can take a minute to fall after something is released.</p>` : "";
    const scanHtml = scan ? this.scanHTML(scan) : "";
    return `<div class="ld-grid2">
      <div><h3>A/B tests</h3><p class="ld-hint">Each one samples before, runs, waits a few seconds, then samples again. Use them mid-session when it feels slow.</p>${actions}${diff}</div>
      <div><h3>Deep scan</h3><p class="ld-hint">Watches everything for 30 seconds: which part of the page keeps changing, which hooks fire, which callbacks and modules take the time. Run it while the lag is happening.</p>
        <button type="button" data-do="scan"><i class="fa-solid fa-magnifying-glass"></i> Deep scan (30 s)</button><div class="ld-progress"></div>
        <h3>Marks</h3><div class="ld-markrow"><input type="text" class="ld-markin" placeholder="What just happened? e.g. 'fireball lagged'"><button type="button" data-do="mark"><i class="fa-solid fa-flag"></i> Mark</button></div>
        <h3>Save and share</h3>
        <button type="button" data-do="json"><i class="fa-solid fa-file-code"></i> Download full report (JSON)</button>
        <button type="button" data-do="csv"><i class="fa-solid fa-file-csv"></i> Download samples (CSV)</button>
        ${game.user.isGM ? `<button type="button" data-do="save"><i class="fa-solid fa-floppy-disk"></i> Save to the Data folder now</button>` : ""}
        <p class="ld-hint">${game.user.isGM ? `The GM's report also saves itself to <code>Data/${MODULE_ID}-data/${esc(game.world.id)}/</code> every 10 minutes (setting), so it survives a crash or a forgotten download.` : ""}</p>
        <h3>Start over</h3><button type="button" data-do="reset"><i class="fa-solid fa-eraser"></i> Clear all readings</button>
        <p class="ld-hint">Useful after fixing something, to measure the session fresh.</p>
      </div></div>${scanHtml}`;
  }

  scanHTML(s) {
    const tbl = (head, rows) => `<table class="ld-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${head.length}">—</td></tr>`}</tbody></table>`;
    return `<h3 class="ld-scanh">Deep scan at ${s.at} (${s.seconds} s) — ${fmt(s.frames.fps)} fps, slowest 5% of frames ${fmt(s.frames.p95)} ms, ${fmt(s.mutationsPerSec, 1)} page changes/s</h3>
      <div class="ld-grid2">
        <div><h4>Who used the time</h4>${tbl(["Module", "total ms", "slow frames", "hooks", "timers", "layout"], s.owners.map((o) => `<tr><td>${esc(label(o.owner))}</td><td class="n"><b>${fmt(o.total)}</b></td><td class="n">${fmt(o.slowMs)}</td><td class="n">${fmt(o.hookMs, 1)}</td><td class="n">${fmt(o.timerMs, 1)}</td><td class="n">${fmt(o.layoutMs)}</td></tr>`))}</div>
        <div><h4>What part of the page kept changing</h4>${tbl(["Region", "changes/s", "attr", "text", "nodes"], s.regions.map((r) => `<tr><td>${esc(r.region)}</td><td class="n ${r.perSec > 20 ? "bad" : ""}">${fmt(r.perSec, 1)}</td><td class="n">${fmt(r.attr)}</td><td class="n">${fmt(r.text)}</td><td class="n">${fmt(r.nodes)}</td></tr>`))}</div>
        <div><h4>Hooks fired</h4>${tbl(["Hook", "calls", "ms"], s.hooks.map((h) => `<tr><td>${esc(h.hook)}</td><td class="n">${fmt(h.calls)}</td><td class="n">${fmt(h.ms, 1)}</td></tr>`))}</div>
        <div><h4>Slowest callbacks</h4>${tbl(["Module", "Hook · function", "ms"], s.callbacks.map((c) => `<tr><td>${esc(label(c.owner))}</td><td>${esc(c.hook)} · <i>${esc(c.name)}</i></td><td class="n">${fmt(c.ms, 1)}</td></tr>`))}</div>
        <div><h4>Socket messages in</h4>${tbl(["Event", "count"], s.sockets.map((x) => `<tr><td>${esc(x.event)}</td><td class="n">${fmt(x.n)}</td></tr>`))}</div>
        <div><h4>Slow frames during the scan</h4>${tbl(["ms", "top script"], s.slowFrames.map((f) => `<tr><td class="n">${fmt(f.ms)}</td><td>${f.scripts[0] ? `${esc(label(f.scripts[0].owner))} · ${esc(f.scripts[0].fn || f.scripts[0].invoker)} (${fmt(f.scripts[0].ms)} ms)` : "drawing / layout"}</td></tr>`))}</div>
      </div>`;
  }

  // ─────────────────────────────────────────── clicks
  async onClick(e) {
    const th = e.target.closest("th[data-sort]");
    if (th) {
      const k = th.dataset.sort;
      this.sort = { key: k, dir: this.sort.key === k ? -this.sort.dir : (k === "title" ? 1 : -1) };
      return this.draw(true);
    }
    const act = e.target.closest("[data-act]");
    if (act && !this.busy) {
      const a = ACTIONS[act.dataset.act];
      if (a.confirm) {
        const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: a.label }, content: `<p>${esc(a.hint)}</p><p>Go ahead?</p>` });
        if (!ok) return;
      }
      this.busy = true;
      act.disabled = true;
      act.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Testing…`;
      try { this.lastAction = await runAction(act.dataset.act, this); }
      catch (err) { ui.notifications.error(`Lag Detective: ${err.message}`); }
      this.busy = false;
      return this.draw(true);
    }
    const b = e.target.closest("[data-do]");
    if (!b || this.busy) return;
    switch (b.dataset.do) {
      case "mark": {
        const txt = this.el.body.querySelector(".ld-markin")?.value?.trim() || "Lag felt here";
        mark(txt);
        await sample(txt);
        ui.notifications.info(`Marked: ${txt}`);
        return this.draw(true);
      }
      case "scan": {
        this.busy = true;
        if (this.tab !== "tools") this.show("tools");
        const prog = this.el.body.querySelector(".ld-progress");
        const btn = this.el.body.querySelector('[data-do="scan"]');
        if (btn) btn.disabled = true;
        await deepScan(30, (s, t) => { if (prog) prog.innerHTML = `<i style="width:${(s / t) * 100}%"></i><span>${t - s} s left — keep playing normally</span>`; });
        this.busy = false;
        return this.draw();
      }
      case "poll": {
        b.disabled = true; b.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Waiting for answers…`;
        this.poll = await pollPlayers();
        return this.draw();
      }
      case "recheck": this.check = null; this.check = await getCheckup(true); return this.draw();
      case "json": return downloadReport();
      case "csv": return downloadCSV();
      case "save": try { await saveToData({ notify: true }); } catch (err) { ui.notifications.error(`Could not save: ${err.message}`); } return this.drawStatus();
      case "reset": {
        const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: "Clear all readings" }, content: "<p>Throw away every sample and per-module total and start measuring from now?</p>" });
        if (!ok) return;
        restartSession(); resetSession(); this.lastAction = null; S.lastScan = null;
        mark("Readings cleared", "mark");
        return this.draw();
      }
    }
  }
}
