// Location panel: REAL geolocation is the primary source — mounting this
// starts navigator.geolocation (getCurrentPosition + watchPosition) and the
// map follows real fixes. "SIMULATE GPS (demo mode)" is an EXPLICIT overlay:
// it engages only when the user picks a preset here, or via URL param —
//   ?demo=1        auto-apply preset 0 at mount (the deterministic demo/video
//                  path: video/scenes.mjs and docs/DEMO-RUNBOOK.md rely on it)
//   ?devloc=<n>    auto-apply preset <n> of the active pack
//   ?fix=lat,lon[,elevM]  demo GPS at arbitrary coordinates (coverage testing)
// Without a param and without a granted GPS fix, the app honestly has NO
// position (tools return structured no_fix). Collapsible, bottom-left. Preset
// list is pack-specific (see setPack) — matches whichever region the pack
// picker has switched to.

import { getFixState, setSimulatedFix, startRealGeolocation } from '../tools/location';
import { demoRequestFromSearch } from './devloc-url';

interface LocationPreset {
  label: string;
  lat: number;
  lon: number;
  elevationM: number;
}

const PRESETS_BY_PACK: Record<string, LocationPreset[]> = {
  sandia: [
    // Matches src/tools/pack.ts's default fix for this pack exactly (same demo scene).
    { label: 'La Luz upper switchbacks (default)', lat: 35.1983, lon: -106.4439, elevationM: 2926 },
    { label: 'Sandia Crest', lat: 35.2100245, lon: -106.4496247, elevationM: 3255 },
    { label: 'Tram top', lat: 35.2075, lon: -106.4478, elevationM: 3163 },
  ],
  chamonix: [
    { label: 'Lac Blanc trail (default)', lat: 45.97, lon: 6.885, elevationM: 2352 },
    { label: "Plan de l'Aiguille", lat: 45.9089, lon: 6.8519, elevationM: 2233 },
  ],
  fontainebleau: [
    // Matches src/tools/pack.ts's own default fix for this pack exactly.
    { label: 'Gorges de Franchard (default)', lat: 48.4058, lon: 2.6386, elevationM: 130 },
    { label: 'Barbizon village', lat: 48.4462, lon: 2.6108, elevationM: 80 },
    { label: 'Apremont boulders', lat: 48.43, lon: 2.628, elevationM: 120 },
  ],
};

// Simulated fixes don't have a real accuracy reading; a nominal handheld-GPS
// figure keeps the demo-mode display sensible.
const SIMULATED_ACCURACY_M = 14;

export interface DevLocOptions {
  /** Fires on every accepted fix — demo preset OR real GPS — so the map view
   *  can re-center on whatever position the tools will actually report. */
  onFixChange?(lat: number, lon: number, accuracyM: number): void;
  /** When given, REAL geolocation (and its browser permission prompt) waits
   *  for this to resolve — e.g. until the onboarding gate is dismissed by a
   *  user gesture. A no-gesture prompt at second zero from an unknown origin
   *  is a trust hit and Chrome's quiet-permission heuristics often suppress
   *  it anyway. Demo URL params are unaffected (no prompt involved). */
  startRealGeoAfter?: Promise<void>;
}

export interface DevLocHandle {
  /**
   * Called on a 'pack-changed' event: swaps the preset dropdown to this
   * pack's list and updates the displayed coords to match. Does NOT call
   * onFixChange/setSimulatedFix itself — switchPack() on the agent already
   * set the fix (demo mode only); re-applying preset 0 here too could race
   * it with a value that doesn't quite match. This only keeps the dropdown +
   * coords display honest for whenever the user picks a preset manually next.
   */
  setPack(packId: string, fix: { lat: number; lon: number }): void;
}

export function mountDevLoc(opts: DevLocOptions = {}): DevLocHandle {
  const panel = document.createElement('div');
  panel.className = 'devloc-panel';
  panel.dataset.open = 'false';
  panel.dataset.demo = 'false';
  panel.innerHTML = `
    <button type="button" class="devloc-toggle" aria-label="Demo mode — simulated GPS">
      <span class="devloc-toggle-glyph">&#8982;</span><span class="devloc-toggle-label">GPS</span>
    </button>
    <div class="devloc-body">
      <span class="devloc-label">DEMO MODE &mdash; SIMULATED GPS</span>
      <span class="devloc-hint">Explore any region without being there. Real GPS stays the default in the field.</span>
      <select class="devloc-select"></select>
      <div class="devloc-coords"></div>
    </div>
  `;
  document.body.appendChild(panel);

  const toggle = panel.querySelector<HTMLButtonElement>('.devloc-toggle')!;
  const select = panel.querySelector<HTMLSelectElement>('.devloc-select')!;
  const coords = panel.querySelector<HTMLElement>('.devloc-coords')!;

  let activePack = 'sandia';
  let activePresets = PRESETS_BY_PACK[activePack];

  toggle.addEventListener('click', () => {
    panel.dataset.open = panel.dataset.open === 'true' ? 'false' : 'true';
  });

  function renderOptions(): void {
    select.innerHTML = activePresets.map((p, i) => `<option value="${i}">${p.label}</option>`).join('');
  }

  /** Explicit DEMO GPS: apply a preset and flag the panel as demo-active. */
  function applyPreset(index: number): void {
    const preset = activePresets[index];
    if (!preset) return;
    select.value = String(index);
    panel.dataset.demo = 'true';
    coords.textContent = `${preset.lat.toFixed(4)}, ${preset.lon.toFixed(4)} · DEMO GPS`;
    setSimulatedFix({ lat: preset.lat, lon: preset.lon, elevationM: preset.elevationM, accuracyM: SIMULATED_ACCURACY_M });
    opts.onFixChange?.(preset.lat, preset.lon, SIMULATED_ACCURACY_M);
  }

  function setPack(packId: string, fix: { lat: number; lon: number }): void {
    if (!PRESETS_BY_PACK[packId]) {
      console.warn(`[helius] devloc has no presets for pack "${packId}" — falling back to sandia's list (fix display is still accurate, just the preset dropdown isn't pack-appropriate)`);
    }
    activePack = PRESETS_BY_PACK[packId] ? packId : 'sandia';
    activePresets = PRESETS_BY_PACK[activePack];
    renderOptions();
    // Reflect the fix switchPack() actually kept/set (may not exactly equal
    // preset 0 above) without re-triggering onFixChange/setSimulatedFix.
    const demo = getFixState().demoMode;
    coords.textContent = `${fix.lat.toFixed(4)}, ${fix.lon.toFixed(4)}${demo ? ' · DEMO GPS' : ''}`;
    const matchIndex = activePresets.findIndex((p) => p.lat === fix.lat && p.lon === fix.lon);
    select.value = String(matchIndex >= 0 ? matchIndex : 0);
  }

  renderOptions();
  select.addEventListener('change', () => applyPreset(Number(select.value)));

  const demoReq = demoRequestFromSearch(location.search);
  if (demoReq?.kind === 'preset') {
    // Deterministic demo path (?demo=1 / ?devloc=<n>) — today's video + judge
    // runbook behavior: the simulated fix is live before the first question.
    applyPreset(Math.min(demoReq.index, activePresets.length - 1));
  } else if (demoReq?.kind === 'fix') {
    // Explicit demo GPS at arbitrary coordinates (?fix=lat,lon[,elevM]) — for
    // exercising coverage honesty (e.g. a fix far off the trail network).
    panel.dataset.demo = 'true';
    coords.textContent = `${demoReq.lat.toFixed(4)}, ${demoReq.lon.toFixed(4)} · DEMO GPS`;
    setSimulatedFix({ lat: demoReq.lat, lon: demoReq.lon, elevationM: demoReq.elevationM, accuracyM: SIMULATED_ACCURACY_M });
    opts.onFixChange?.(demoReq.lat, demoReq.lon, SIMULATED_ACCURACY_M);
  } else {
    // Real GPS is the primary source. Until the first fix lands (or if the
    // permission is denied), the app truthfully has no position.
    coords.textContent = 'waiting for GPS…';
    const startGeo = (): void => {
      if (getFixState().demoMode) return; // a preset was picked while we waited
      startRealGeolocation((fix, source) => {
        if (source === 'gps') {
          coords.textContent = `${fix.lat.toFixed(4)}, ${fix.lon.toFixed(4)} · GPS ±${fix.accuracyM}m`;
          opts.onFixChange?.(fix.lat, fix.lon, fix.accuracyM);
        }
      });
      // If no fix arrives, surface the status once the initial attempt settles.
      window.setTimeout(() => {
        const s = getFixState();
        if (!s.fix && !s.demoMode) {
          coords.textContent =
            s.geoStatus === 'denied' ? 'GPS denied — pick a preset for demo mode' : s.geoStatus === 'requesting' ? 'waiting for GPS…' : 'no GPS — pick a preset for demo mode';
        }
      }, 13_000);
    };
    if (opts.startRealGeoAfter) void opts.startRealGeoAfter.then(startGeo);
    else startGeo();
  }

  return { setPack };
}
