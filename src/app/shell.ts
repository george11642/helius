// Renders the Helius app shell: header (wordmark + offline badge + model
// chip), a two-pane main (chat/voice | map), a footer status bar, and a
// hidden tool-trace overlay. Feature modules (agent/llm/map/speech) should
// mount into the containers ShellRefs exposes rather than touching the DOM
// directly, so the shell stays the single source of layout truth.

export interface ShellRefs {
  chatPanel: HTMLElement;
  mapPanel: HTMLElement;
  toolTrace: HTMLElement;
  statusText: HTMLElement;
  modelChip: HTMLElement;
  offlineBadge: HTMLElement;
}

export function renderShell(root: HTMLElement): ShellRefs {
  root.innerHTML = `
    <header class="shell-header">
      <div class="wordmark">HELIUS</div>
      <div class="header-chips">
        <span class="chip offline-badge" data-state="unknown">Offline-ready: no</span>
        <span class="chip model-chip">Model: not loaded</span>
      </div>
    </header>
    <main class="shell-main">
      <section class="chat-panel" aria-label="Conversation">
        <!-- TODO(agent, speech): mount chat transcript + voice controls here -->
        <p class="placeholder">Model not loaded yet. Voice and chat will appear here.</p>
      </section>
      <section class="map-panel" aria-label="Map">
        <!-- TODO(map): mount the MapLibre canvas here once a region pack loads -->
        <p class="placeholder">Map will render here once a region pack is loaded.</p>
      </section>
    </main>
    <footer class="shell-footer">
      <span class="status-text">Ready.</span>
    </footer>
    <div class="tool-trace" hidden>
      <!-- TODO(agent): render the live tool-call chain here, e.g.
           locate → offline_map → route_back → sun_calc → morse_beacon -->
    </div>
  `;

  return {
    chatPanel: root.querySelector('.chat-panel')!,
    mapPanel: root.querySelector('.map-panel')!,
    toolTrace: root.querySelector('.tool-trace')!,
    statusText: root.querySelector('.shell-footer .status-text')!,
    modelChip: root.querySelector('.model-chip')!,
    offlineBadge: root.querySelector('.offline-badge')!,
  };
}
