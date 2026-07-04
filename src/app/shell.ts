// Renders the Helius app shell: header (wordmark + status chips), a
// two-column main (fixed-width chat/voice column | flexible map column), a
// full-width tool-trace rail, and a footer status bar. Feature modules
// (chat, trace, status, voice, boot, beacon, devloc, route) mount into the
// containers ShellRefs exposes rather than touching the DOM directly, so
// this file stays the single source of layout truth.

export interface ShellRefs {
  /** Own slot, separate from headerChips — status.ts fully replaces
   *  headerChips's innerHTML, which would otherwise wipe this out. */
  headerPackSlot: HTMLElement;
  headerChips: HTMLElement;
  chatMessages: HTMLElement;
  chatInputRow: HTMLElement;
  mapRoot: HTMLElement;
  routeToastLayer: HTMLElement;
  toolTraceRail: HTMLElement;
  statusText: HTMLElement;
}

export function renderShell(root: HTMLElement): ShellRefs {
  root.innerHTML = `
    <header class="shell-header">
      <div class="brand">
        <span class="wordmark">HELIUS <span class="sun-glyph">&#9728;</span></span>
        <span class="subtitle">works when nothing else does</span>
      </div>
      <div class="header-row">
        <div class="header-pack-slot"></div>
        <div class="header-chips"></div>
      </div>
    </header>
    <main class="shell-main">
      <section class="chat-col" aria-label="Conversation">
        <div class="chat-messages"></div>
        <div class="chat-input-row"></div>
      </section>
      <section class="map-col" aria-label="Map">
        <div id="map-root" class="map-canvas">
          <p class="map-placeholder">OFFLINE MAP &mdash; loads with region pack</p>
        </div>
        <div class="route-toast-layer"></div>
      </section>
    </main>
    <div class="tool-trace-rail" hidden></div>
    <footer class="shell-footer">
      <span class="status-text">Booting Helius&hellip;</span>
    </footer>
  `;

  return {
    headerPackSlot: root.querySelector('.header-pack-slot')!,
    headerChips: root.querySelector('.header-chips')!,
    chatMessages: root.querySelector('.chat-messages')!,
    chatInputRow: root.querySelector('.chat-input-row')!,
    mapRoot: root.querySelector('#map-root')!,
    routeToastLayer: root.querySelector('.route-toast-layer')!,
    toolTraceRail: root.querySelector('.tool-trace-rail')!,
    statusText: root.querySelector('.shell-footer .status-text')!,
  };
}
