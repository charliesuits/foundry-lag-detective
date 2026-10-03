/**
 * Lag Detective — entry point.
 *
 * Measurement starts the moment this file loads (before init) so as many hook registrations as possible
 * can be tied to the module that made them. It reads its on/off switch straight from browser storage,
 * because Foundry settings don't exist yet at that point.
 */
import { MODULE_ID, I, startInstrumentation, attachSocket, sweepHooks } from "./instrument.js";
import { S, sample, mark, startSampler, watchEvents } from "./sampler.js";
import { LagDetectiveApp } from "./app.js";
import { showHud } from "./hud.js";
import { registerSocket, saveToData, getCheckup, fullReport, deepScan, pollPlayers, summary } from "./tools.js";
import { suspects, blame } from "./analysis.js";
import { _setInterval, _setTimeout } from "./instrument.js";

function rawClientSetting(key, fallback) {
  try {
    const v = localStorage.getItem(`${MODULE_ID}.${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}

if (rawClientSetting("instrument", true)) startInstrumentation();
else startInstrumentation({ hooks: false, timers: false, listeners: false, console: false });

const open = (tab) => LagDetectiveApp.open(tab);

Hooks.once("init", () => {
  const reload = { requiresReload: true };
  game.settings.register(MODULE_ID, "instrument", {
    name: "Blame modules (hooks, timers, listeners, errors)",
    hint: "Times every hook callback and tracks who creates repeating timers and page-wide listeners, so slow-downs can be charged to a module. Costs very little. Turn off only to rule Lag Detective itself out.",
    scope: "client", config: true, type: Boolean, default: true, ...reload,
  });
  game.settings.register(MODULE_ID, "interval", {
    name: "Seconds between samples",
    hint: "How often a full reading is taken. 30 is right for a whole session; 10 for chasing something quick.",
    scope: "client", config: true, type: Number, default: 30, range: { min: 10, max: 120, step: 5 },
    onChange: (v) => startSampler(v),
  });
  game.settings.register(MODULE_ID, "hud", {
    name: "Show the indicator",
    hint: "A small readout at the top of the screen: frame rate, memory, server round trip and suspect count.",
    scope: "client", config: true, type: String, default: "gm",
    choices: { gm: "For the GM only", on: "Always", off: "Never" }, ...reload,
  });
  game.settings.register(MODULE_ID, "autosave", {
    name: "Save a report to the Data folder (GM)",
    hint: `Every 10 minutes, the GM's full report is written to Data/${MODULE_ID}-data/<world>/. It survives a crash and can be read later without anyone downloading anything.`,
    scope: "client", config: true, type: Boolean, default: true,
  });
  game.settings.register(MODULE_ID, "measureBytes", {
    name: "Measure socket message sizes",
    hint: "Adds up how much data each socket event carries. Turn off if you move huge scenes around constantly.",
    scope: "client", config: true, type: Boolean, default: true, onChange: (v) => { I.measureBytes = v; },
  });
  game.settings.register(MODULE_ID, "answerPolls", {
    name: "Players answer lag checks",
    hint: "When the GM presses 'Check all players', each player's client sends back its own readings (frame rate, memory, graphics card).",
    scope: "world", config: true, type: Boolean, default: true,
  });

  game.keybindings.register(MODULE_ID, "open", {
    name: "Open Lag Detective", editable: [{ key: "KeyL", modifiers: ["Control", "Shift"] }],
    onDown: () => { open(); return true; },
  });
  game.keybindings.register(MODULE_ID, "mark", {
    name: "Mark 'lag felt here'", hint: "Drops a marker on the timeline and takes a reading right away.",
    editable: [{ key: "KeyM", modifiers: ["Control", "Shift"] }],
    onDown: () => { mark("Lag felt here"); sample("Lag felt here"); ui.notifications.info("Lag Detective: marked"); return true; },
  });
});

Hooks.once("ready", () => {
  I.measureBytes = game.settings.get(MODULE_ID, "measureBytes");
  try { attachSocket(); } catch (e) { console.warn(`${MODULE_ID} | socket counting unavailable`, e); }
  try { registerSocket(); } catch (e) { console.warn(`${MODULE_ID} | poll socket unavailable`, e); }
  sweepHooks();
  watchEvents();
  mark("World ready", "scene");
  S.t0 = Date.now(); S.lastSample = Date.now();
  startSampler(game.settings.get(MODULE_ID, "interval"));
  _setTimeout(() => sample("first reading"), 5000);
  _setTimeout(() => getCheckup(true).catch(() => {}), 20000);

  const hud = game.settings.get(MODULE_ID, "hud");
  if (hud === "on" || (hud === "gm" && game.user.isGM)) showHud(open);

  if (game.user.isGM) {
    _setInterval(() => {
      if (game.settings.get(MODULE_ID, "autosave") && S.rows.length >= 2) saveToData().catch((e) => console.warn(`${MODULE_ID} | autosave failed`, e));
    }, 10 * 60 * 1000);
  }

  const api = { open, mark, sample, suspects, blame, report: fullReport, scan: deepScan, poll: pollPlayers, save: saveToData, summary, samples: S.rows, events: S.events, state: I };
  game.modules.get(MODULE_ID).api = api;
  globalThis.LagDetective = api;
  console.log(`${MODULE_ID} | watching. Ctrl+Shift+L opens the window, Ctrl+Shift+M marks a lag moment.`);
});

// A button in the Settings sidebar
Hooks.on("renderSettings", (app, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".ld-open")) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ld-open";
  b.innerHTML = `<i class="fa-solid fa-magnifying-glass-chart"></i> Lag Detective`;
  b.addEventListener("click", (e) => { e.preventDefault(); open(); });
  const anchor = root.querySelector("section.documentation, #settings-documentation, section.settings, section") ?? root;
  anchor.append(b);
});
