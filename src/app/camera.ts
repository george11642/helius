// Camera capture for the read_sign beat: a button next to the mic opens a
// full-viewport preview (environment-facing camera, lazy — no getUserMedia
// call until the first click); tapping the preview grabs the current frame
// to a canvas, closes the preview, and hands it to onCapture. The tool trace
// rail takes it from there once the agent's readSign() runs.

export interface CameraOptions {
  onCapture(image: HTMLCanvasElement): void;
}

export interface CameraHandle {
  setEnabled(enabled: boolean): void;
}

export function mountCamera(container: HTMLElement, opts: CameraOptions): CameraHandle {
  container.innerHTML = `<button type="button" class="camera-btn" aria-label="Read a sign" disabled>&#128247;</button>`;
  const btn = container.querySelector<HTMLButtonElement>('.camera-btn')!;

  const overlay = document.createElement('div');
  overlay.className = 'camera-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <button type="button" class="camera-close" aria-label="Cancel">&times;</button>
    <video class="camera-preview" autoplay playsinline muted></video>
    <div class="camera-hint">READ SIGN &mdash; point at the sign, tap to capture</div>
    <div class="camera-error" hidden></div>
  `;
  document.body.appendChild(overlay);
  const video = overlay.querySelector<HTMLVideoElement>('.camera-preview')!;
  const closeBtn = overlay.querySelector<HTMLButtonElement>('.camera-close')!;
  const errorEl = overlay.querySelector<HTMLElement>('.camera-error')!;

  let stream: MediaStream | null = null;

  async function openCamera(): Promise<void> {
    errorEl.hidden = true;
    overlay.hidden = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = stream;
    } catch (err) {
      console.warn('[helius] camera permission denied or unavailable', err);
      errorEl.hidden = false;
      errorEl.textContent = 'Camera unavailable — check permissions.';
    }
  }

  function closeCamera(): void {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    video.srcObject = null;
    overlay.hidden = true;
  }

  function capture(): void {
    if (!stream || video.videoWidth === 0) return; // no frame ready yet — ignore the tap
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    closeCamera();
    opts.onCapture(canvas);
  }

  btn.addEventListener('click', () => void openCamera());
  overlay.addEventListener('click', capture);
  closeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation(); // don't let it bubble to overlay's capture handler
    closeCamera();
  });

  function setEnabled(enabled: boolean): void {
    btn.disabled = !enabled;
  }

  return { setEnabled };
}
