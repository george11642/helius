// Dev/demo location panel: Macs have no GPS, so "SIMULATE GPS (demo mode)"
// is a first-class, intentional feature rather than a hack — lets the app be
// demoed and video'd from a laptop at a desk. Collapsible, bottom-left.
// Preset list is pack-specific (see setPack) — matches whichever region the
// pack picker has switched to.

interface LocationPreset {
  label: string;
  lat: number;
  lon: number;
  elevationM: number;
}

const PRESETS_BY_PACK: Record<string, LocationPreset[]> = {
  sandia: [
    // Matches src/tools/location.ts's own default fix exactly (same demo scene).
    { label: 'La Luz upper switchbacks (default)', lat: 35.1983, lon: -106.4439, elevationM: 2926 },
    { label: 'Sandia Crest', lat: 35.2100245, lon: -106.4496247, elevationM: 3255 },
    { label: 'Tram top', lat: 35.2075, lon: -106.4478, elevationM: 3163 },
  ],
  chamonix: [
    { label: 'Lac Blanc trail (default)', lat: 45.97, lon: 6.885, elevationM: 2352 },
    { label: "Plan de l'Aiguille", lat: 45.9089, lon: 6.8519, elevationM: 2233 },
  ],
};

// Simulated fixes don't have a real accuracy reading; matches location.ts's
// own default fix's accuracyM (14) closely enough for a demo-mode display.
const SIMULATED_ACCURACY_M = 14;

export interface DevLocOptions {
  /** Fires on every preset selection (including the initial default) so the
   *  map view can re-center — independent of whether tools/location.ts has
   *  landed yet, since that's a separate concern from what the map shows. */
  onFixChange?(lat: number, lon: number, accuracyM: number): void;
}

export interface DevLocHandle {
  /**
   * Called on a 'pack-changed' event: swaps the preset dropdown to this
   * pack's list and updates the displayed coords to match. Does NOT call
   * onFixChange/setSimulatedFix itself — switchPack() on the agent already
   * set the real fix for the new pack; re-applying preset 0 here too could
   * race it with a value that doesn't quite match. This only keeps the
   * dropdown + coords display honest for whenever the user picks a preset
   * manually next.
   */
  setPack(packId: string, fix: { lat: number; lon: number }): void;
}

export function mountDevLoc(opts: DevLocOptions = {}): DevLocHandle {
  const panel = document.createElement('div');
  panel.className = 'devloc-panel';
  panel.dataset.open = 'false';
  panel.innerHTML = `
    <button type="button" class="devloc-toggle" aria-label="Simulate GPS (demo mode)">&#9881;</button>
    <div class="devloc-body">
      <span class="devloc-label">SIMULATE GPS (demo mode)</span>
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

  async function applyPreset(index: number): Promise<void> {
    const preset = activePresets[index];
    if (!preset) return;
    select.value = String(index);
    coords.textContent = `${preset.lat.toFixed(4)}, ${preset.lon.toFixed(4)}`;
    opts.onFixChange?.(preset.lat, preset.lon, SIMULATED_ACCURACY_M);
    try {
      // src/tools/location.ts now definitively exists — a static, literal
      // import so it's actually bundled into production output. (A non-literal
      // specifier + @vite-ignore was used earlier as a soft dependency while
      // this was still landing; that only worked in dev — production builds
      // never discover or emit the file, so the import 404s there. Same
      // lesson as main.ts's agent import; see that file for the full story.)
      const { setSimulatedFix } = await import('../tools/location');
      setSimulatedFix({ lat: preset.lat, lon: preset.lon, elevationM: preset.elevationM, accuracyM: SIMULATED_ACCURACY_M });
    } catch (err) {
      console.warn('[helius] tools/location.ts failed to load — GPS fix is display-only', err);
    }
  }

  function setPack(packId: string, fix: { lat: number; lon: number }): void {
    activePack = PRESETS_BY_PACK[packId] ? packId : 'sandia';
    activePresets = PRESETS_BY_PACK[activePack];
    renderOptions();
    // Reflect the fix switchPack() actually set (may not exactly equal
    // preset 0 above) without re-triggering onFixChange/setSimulatedFix.
    coords.textContent = `${fix.lat.toFixed(4)}, ${fix.lon.toFixed(4)}`;
    const matchIndex = activePresets.findIndex((p) => p.lat === fix.lat && p.lon === fix.lon);
    select.value = String(matchIndex >= 0 ? matchIndex : 0);
  }

  renderOptions();
  select.addEventListener('change', () => void applyPreset(Number(select.value)));
  void applyPreset(0);

  return { setPack };
}
