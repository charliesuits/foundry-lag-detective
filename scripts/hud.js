/**
 * Lag Detective — the small always-visible indicator.
 * Click: open the window. Shift-click: mark "lag felt here".
 */
import { MODULE_ID, frameStats, _setInterval } from "./instrument.js";
import { S, sample, mark } from "./sampler.js";
import { suspects } from "./analysis.js";

let el = null;
let serious = 0;

export function showHud(open) {
  if (el) return;
  el = document.createElement("div");
  el.id = "lag-detective-hud";
  el.innerHTML = `<i class="ld-dot"></i><span class="ld-h-fps">—</span><span class="ld-h-mem"></span><span class="ld-h-ping"></span><b class="ld-h-sus"></b>`;
  el.dataset.tooltip = "Lag Detective — click to open, Shift-click to mark 'lag felt here'";
  el.addEventListener("click", async (e) => {
    if (e.shiftKey) { mark("Lag felt here"); await sample("Lag felt here"); ui.notifications.info("Marked: lag felt here"); return; }
    open();
  });
  document.body.append(el);
  _setInterval(update, 2000);
  Hooks.on(`${MODULE_ID}.sample`, () => {
    try { serious = suspects().filter((s) => s.sev === "high" || s.sev === "medium").length; } catch { serious = 0; }
    update();
  });
}

function update() {
  if (!el) return;
  const f = frameStats();
  const r = S.rows.at(-1) ?? {};
  const fps = f.fps;
  const bad = (fps !== null && fps < 28) || f.p95 > 80 || r.pingMs > 800 || r.stallMax > 1000;
  const warn = (fps !== null && fps < 45) || f.p95 > 40 || r.pingMs > 300 || r.stallMax > 300;
  el.className = document.hidden ? "" : bad ? "bad" : warn ? "warn" : "good";
  el.querySelector(".ld-h-fps").textContent = fps === null ? "— fps" : `${fps} fps`;
  el.querySelector(".ld-h-mem").textContent = r.heapMB ? `${r.heapMB.toLocaleString()} MB` : "";
  el.querySelector(".ld-h-ping").textContent = typeof r.pingMs === "number" ? `${r.pingMs} ms` : "";
  const s = el.querySelector(".ld-h-sus");
  s.textContent = serious ? `${serious} suspect${serious === 1 ? "" : "s"}` : "";
  s.style.display = serious ? "" : "none";
}

export function hideHud() { el?.remove(); el = null; }
