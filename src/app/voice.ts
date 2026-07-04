// Mic button: supports both hold-to-talk (press, speak, release) and
// click-to-toggle (quick tap starts it, a second tap stops it) — a press
// shorter than TAP_THRESHOLD_MS arms toggle mode instead of stopping
// immediately, since a real hold gesture takes longer than a reflexive tap.
// While recording, draws a live waveform from the STT module's AnalyserNode.

import { startRecording, type VoiceRecorder } from '../speech/stt';

const TAP_THRESHOLD_MS = 250;

export interface VoiceHandle {
  setEnabled(enabled: boolean): void;
}

export interface VoiceOptions {
  onAudio(samples: Float32Array): void;
}

function accentColor(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return v || '#ffb454';
}

export function mountMic(container: HTMLElement, opts: VoiceOptions): VoiceHandle {
  container.innerHTML = `
    <button type="button" class="mic-btn" data-recording="false" aria-label="Hold or tap to talk" disabled>&#127908;</button>
    <canvas class="mic-waveform" width="64" height="32" hidden></canvas>
  `;
  const micBtn = container.querySelector<HTMLButtonElement>('.mic-btn')!;
  const canvas = container.querySelector<HTMLCanvasElement>('.mic-waveform')!;
  const canvasCtx = canvas.getContext('2d')!;

  let recorder: VoiceRecorder | null = null;
  let starting = false;
  let pendingStop = false;
  let toggleArmed = false;
  let pressStart = 0;
  let rafId: number | null = null;

  function drawWaveform(analyser: AnalyserNode): void {
    const data = new Uint8Array(analyser.fftSize);
    const color = accentColor();
    const step = () => {
      analyser.getByteTimeDomainData(data);
      canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
      canvasCtx.beginPath();
      canvasCtx.strokeStyle = color;
      canvasCtx.lineWidth = 2;
      const sliceWidth = canvas.width / data.length;
      let x = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i] / 128 - 1;
        const y = canvas.height / 2 + v * (canvas.height / 2 - 2);
        if (i === 0) canvasCtx.moveTo(x, y);
        else canvasCtx.lineTo(x, y);
        x += sliceWidth;
      }
      canvasCtx.stroke();
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  }

  function stopWaveform(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
  }

  async function beginRecording(): Promise<void> {
    if (starting || recorder) return;
    starting = true;
    pendingStop = false;
    micBtn.dataset.recording = 'true';
    try {
      const rec = await startRecording();
      starting = false;
      if (pendingStop) {
        // Released before the mic finished initializing — capture whatever
        // was caught (likely near-silent) rather than discard the gesture.
        recorder = rec;
        await endRecording();
        return;
      }
      recorder = rec;
      canvas.hidden = false;
      drawWaveform(rec.analyser);
    } catch (err) {
      console.warn('[helius] mic permission/setup failed', err);
      starting = false;
      micBtn.dataset.recording = 'false';
    }
  }

  async function endRecording(): Promise<void> {
    const active = recorder;
    recorder = null;
    canvas.hidden = true;
    stopWaveform();
    micBtn.dataset.recording = 'false';
    if (!active) return;
    try {
      const samples = await active.stop();
      opts.onAudio(samples);
    } catch (err) {
      console.warn('[helius] voice capture failed', err);
    }
  }

  function requestStop(): void {
    if (starting) {
      pendingStop = true;
      return;
    }
    void endRecording();
  }

  micBtn.addEventListener('pointerdown', (ev) => {
    if (micBtn.disabled) return;
    ev.preventDefault();
    micBtn.setPointerCapture(ev.pointerId);
    if (!recorder && !starting) {
      pressStart = performance.now();
      toggleArmed = false;
      void beginRecording();
      return;
    }
    if (toggleArmed) {
      toggleArmed = false;
      requestStop();
    }
  });

  micBtn.addEventListener('pointerup', () => {
    if (!recorder && !starting) return;
    const heldMs = performance.now() - pressStart;
    if (heldMs > TAP_THRESHOLD_MS) {
      requestStop();
    } else {
      toggleArmed = true;
    }
  });

  micBtn.addEventListener('pointercancel', () => {
    toggleArmed = false;
    if (recorder || starting) requestStop();
  });

  function setEnabled(enabled: boolean): void {
    micBtn.disabled = !enabled;
  }

  return { setEnabled };
}
