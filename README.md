# Lag Detective

Finds out why a Foundry VTT session gets laggy — and which module, setting, scene or machine is responsible.

It runs quietly all session and watches:

- **Smoothness** — frame rate, the slowest 5% of frames, hitches, and main-thread freezes.
- **Blame by script** — every slow frame is broken down to the script that ran in it (Chrome/Edge 123+ and current Foundry desktop apps), and charged to its module.
- **Hooks** — every hook callback is timed and tied to the module that registered it; hook call rates show render and update storms.
- **Leaks** — JS memory, GPU image memory, canvas objects, 3D Canvas geometry/textures, videos, page size, open windows, registered hooks, repeating timers and page-wide listeners. A straight-line fit flags anything that climbs steadily, and names the module whose registrations, timers or listeners grow.
- **Server and network** — a server round trip every sample, Foundry's own latency, and socket traffic in and out broken down by event and document type.
- **Errors** — console errors and warnings per minute, charged to the module that logged them.

## Using it

- A small indicator at the top of the screen shows frame rate, memory, server round trip and how many suspects there are. Click it to open the window; **Shift-click** (or **Ctrl+Shift+M**) marks "lag felt here" on the timeline.
- **Ctrl+Shift+L** opens the window. There's also a button in the Settings sidebar.

Tabs:

| Tab | What it's for |
|---|---|
| Overview | The current readings and a ranked list of suspects, each with what to try next. |
| Timeline | Every counter over the session, with scene changes, combats, players joining and your marks drawn on. |
| Modules | Per-module main-thread time, forced layout, hook time, timers, and growth in hook registrations, intervals and listeners. |
| Activity | Busiest hooks, slowest callbacks (grouped, so "×40 copies" stands out), socket traffic, timers and errors. |
| Slow frames | Every frame over 100 ms with the scripts that ran in it. |
| Players | Asks every connected client for its own readings (frame rate, memory, graphics card, top suspects). |
| Checkup | Software rendering, display scaling, performance mode, huge images, wall/light counts, module count and known heavy modules. |
| Tools | Before/after tests (free textures, re-render chat, close windows, redraw canvas, clear the 3D cache, end Sequencer effects), a 30-second deep scan, marks, and export. |

Leak detection needs about 15–20 minutes of samples. The GM's report saves itself to `Data/lag-detective-data/<world>/` every 10 minutes (on The Forge, to your Forge storage) so it survives a crash.

## Cost

Everything is read-only. Hook timing adds two clock reads per callback; the sampler runs once every 30 seconds. Turn off "Blame modules" in the settings to rule Lag Detective itself out.


## Sending a report

On the Tools tab, **Download full report (JSON)** saves the whole report as a file you can send to whoever is helping you.

## Installing

In Foundry, go to **Add-on Modules → Install Module**, paste this manifest URL and click **Install**:

```
https://github.com/charliesuits/foundry-lag-detective/releases/latest/download/module.json
```

Then enable it in your world under **Manage Modules**. Foundry will offer updates automatically when a new version is released.

Works with Foundry VTT v13 and v14.

## License

MIT
