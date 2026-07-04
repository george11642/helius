// Dev/demo location panel: Macs have no GPS, so "SIMULATE GPS (demo mode)"
// is a first-class, intentional feature rather than a hack — lets the app be
// demoed and video'd from a laptop at a desk. Collapsible, bottom-left.

interface LocationPreset {
  label: string;
  lat: number;
  lon: number;
  elevationM: number;
}

const PRESETS: LocationPreset[] = [
  // Matches src/tools/location.ts's own default fix exactly (same demo scene).
  { label: 'La Luz upper switchbacks (default)', lat: 35.1983, lon: -106.4439, elevationM: 2926 },
  { label: 'Sandia Crest', lat: 35.2100245, lon: -106.4496247, elevationM: 3255 },
  { label: 'Tram top', lat: 35.2075, lon: -106.4478, elevationM: 3163 },
  { label: 'Chamonix — Lac Blanc', lat: 45.944, lon: 6.9508, elevationM: 2352 },
];

export function mountDevLoc(): void {
  const panel = document.createElement('div');
  panel.className = 'devloc-panel';
  panel.dataset.open = 'false';
  panel.innerHTML = `
    <button type="button" class="devloc-toggle" aria-label="Simulate GPS (demo mode)">&#9881;</button>
    <div class="devloc-body">
      <span class="devloc-label">SIMULATE GPS (demo mode)</span>
      <select class="devloc-select">
        ${PRESETS.map((p, i) => `<option value="${i}">${p.label}</option>`).join('')}
      </select>
      <div class="devloc-coords"></div>
    </div>
  `;
  document.body.appendChild(panel);

  const toggle = panel.querySelector<HTMLButtonElement>('.devloc-toggle')!;
  const select = panel.querySelector<HTMLSelectElement>('.devloc-select')!;
  const coords = panel.querySelector<HTMLElement>('.devloc-coords')!;

  toggle.addEventListener('click', () => {
    panel.dataset.open = panel.dataset.open === 'true' ? 'false' : 'true';
  });

  async function applyPreset(index: number): Promise<void> {
    const preset = PRESETS[index];
    if (!preset) return;
    coords.textContent = `${preset.lat.toFixed(4)}, ${preset.lon.toFixed(4)}`;
    try {
      // Soft dependency: src/tools/location.ts is owned by a parallel
      // workstream and may not exist yet. A non-literal specifier keeps this
      // out of TypeScript's static module resolution and Vite's build-time
      // chunk graph, so neither typecheck nor build hard-fails while it's
      // still landing — see the identical pattern + rationale in main.ts.
      const modulePath = '../tools/location.ts';
      const mod = (await import(/* @vite-ignore */ modulePath)) as {
        setSimulatedFix?: (next: { lat?: number; lon?: number; elevationM?: number; accuracyM?: number }) => void;
      };
      mod.setSimulatedFix?.({ lat: preset.lat, lon: preset.lon, elevationM: preset.elevationM });
    } catch (err) {
      console.warn('[helius] tools/location.ts not available yet — GPS fix is display-only', err);
    }
  }

  select.addEventListener('change', () => void applyPreset(Number(select.value)));
  void applyPreset(0);
}
