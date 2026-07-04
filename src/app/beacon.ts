// Morse/strobe beacon: 'arm' shows a tap-to-fire card; 'start' takes over the
// screen with a rAF-timed white/black strobe (accurate visual timing, no
// setTimeout drift) plus a best-effort attempt at the device torch — which
// won't exist on a Mac, so failure there is expected and silently skipped.
// 'stop' restores everything. Pattern can be a literal word ("SOS") or an
// already-encoded dot/dash string ("... --- ...", '/' = word gap).

import type { AgentEvent } from '../lib/contract';

export interface BeaconHandle {
  handleEvent(e: AgentEvent): void;
}

const UNIT_MS = 200;

const MORSE: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....',
  I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.',
  Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
  Y: '-.--', Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-',
  '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
};

interface Segment {
  on: boolean;
  ms: number;
}

function encodeMorse(input: string): Segment[] {
  const segments: Segment[] = [];
  const trimmed = input.trim();
  const alreadyEncoded = /^[.\-\s/]+$/.test(trimmed) && trimmed.length > 0;
  const tokens = alreadyEncoded ? trimmed.split(/\s+/) : trimmed.toUpperCase().split('');

  function pushSymbols(symbols: string): void {
    for (let i = 0; i < symbols.length; i++) {
      segments.push({ on: true, ms: symbols[i] === '-' ? UNIT_MS * 3 : UNIT_MS });
      if (i < symbols.length - 1) segments.push({ on: false, ms: UNIT_MS });
    }
  }

  tokens.forEach((token, idx) => {
    if (alreadyEncoded) {
      if (token === '/') {
        segments.push({ on: false, ms: UNIT_MS * 7 });
        return;
      }
      pushSymbols(token);
    } else {
      if (token === ' ') {
        segments.push({ on: false, ms: UNIT_MS * 7 });
        return;
      }
      const code = MORSE[token];
      if (!code) return; // skip unsupported characters
      pushSymbols(code);
    }
    if (idx < tokens.length - 1) segments.push({ on: false, ms: UNIT_MS * 3 });
  });

  return segments;
}

function segmentStateAt(segments: Segment[], totalMs: number, elapsedSinceStart: number): boolean {
  const elapsed = elapsedSinceStart % totalMs;
  let acc = 0;
  for (const seg of segments) {
    if (elapsed >= acc && elapsed < acc + seg.ms) return seg.on;
    acc += seg.ms;
  }
  return false;
}

export function mountBeacon(): BeaconHandle {
  const armedCard = document.createElement('button');
  armedCard.type = 'button';
  armedCard.className = 'beacon-armed-card';
  armedCard.hidden = true;
  armedCard.textContent = 'MORSE BEACON ARMED — SOS ▸ tap to fire';
  document.body.appendChild(armedCard);

  const strobeOverlay = document.createElement('div');
  strobeOverlay.className = 'beacon-strobe-overlay';
  strobeOverlay.hidden = true;
  strobeOverlay.innerHTML = `<div class="beacon-strobe-text"></div>`;
  document.body.appendChild(strobeOverlay);
  const strobeText = strobeOverlay.querySelector<HTMLElement>('.beacon-strobe-text')!;

  let armedPattern: string | undefined;
  let rafId: number | null = null;
  let torchIntervalId: number | undefined;
  let torchTrack: MediaStreamTrack | null = null;

  async function attemptTorch(segments: Segment[], totalMs: number, startTime: number): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const track = stream.getVideoTracks()[0];
      // 'torch' is a non-standard MediaTrackCapabilities extension (mainly
      // Android Chrome) that lib.dom.d.ts doesn't type — hence the casts.
      const caps = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
      if (!caps.torch) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      torchTrack = track;
    } catch (err) {
      console.warn('[helius] torch unavailable (expected on most laptops/desktops)', err);
      return;
    }

    let lastOn: boolean | null = null;
    torchIntervalId = window.setInterval(() => {
      if (!torchTrack) return;
      const on = segmentStateAt(segments, totalMs, performance.now() - startTime);
      if (on !== lastOn) {
        lastOn = on;
        torchTrack.applyConstraints({ advanced: [{ torch: on } as unknown as MediaTrackConstraintSet] }).catch(() => {});
      }
    }, 60);
  }

  function startStrobe(pattern: string | undefined): void {
    const text = pattern && pattern.trim() ? pattern : 'SOS';
    const segments = encodeMorse(text);
    if (segments.length === 0) return;
    const totalMs = segments.reduce((sum, s) => sum + s.ms, 0) + UNIT_MS * 7;

    armedCard.hidden = true;
    strobeOverlay.hidden = false;
    strobeText.textContent = `TRANSMITTING ${text.toUpperCase()} — tap to stop`;

    const startTime = performance.now();
    const frame = () => {
      const on = segmentStateAt(segments, totalMs, performance.now() - startTime);
      strobeOverlay.style.background = on ? '#fff' : '#000';
      rafId = requestAnimationFrame(frame);
    };
    rafId = requestAnimationFrame(frame);

    void attemptTorch(segments, totalMs, startTime);
  }

  function stopStrobe(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (torchIntervalId !== undefined) {
      window.clearInterval(torchIntervalId);
      torchIntervalId = undefined;
    }
    if (torchTrack) {
      const track = torchTrack;
      torchTrack = null;
      track.applyConstraints({ advanced: [{ torch: false } as unknown as MediaTrackConstraintSet] }).catch(() => {});
      track.stop();
    }
    strobeOverlay.hidden = true;
    armedCard.hidden = true;
  }

  armedCard.addEventListener('click', () => startStrobe(armedPattern));
  strobeOverlay.addEventListener('click', () => stopStrobe());

  function handleEvent(e: AgentEvent): void {
    if (e.type !== 'beacon') return;
    if (e.action === 'arm') {
      armedPattern = e.pattern;
      armedCard.hidden = false;
    } else if (e.action === 'start') {
      startStrobe(e.pattern ?? armedPattern);
    } else if (e.action === 'stop') {
      stopStrobe();
    }
  }

  return { handleEvent };
}
