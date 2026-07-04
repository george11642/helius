// Speech input, capture side only: mic -> MediaRecorder -> decoded PCM ->
// resampled to 16kHz mono Float32Array, the exact shape GenerateRequest.audio
// / createHelius().sendVoice() expect. Actual transcription happens on-device
// inside the agent/llm layer (Gemma/whisper-class model) once it receives
// this buffer; the resulting text comes back as a 'user-message' AgentEvent.
// This module never sends audio off-device.

const TARGET_SAMPLE_RATE = 16000;

export interface VoiceRecorder {
  /** Live analyser for voice.ts's waveform canvas — not connected to
   *  destination, so monitoring never causes mic feedback/echo. */
  analyser: AnalyserNode;
  /** Stops recording and resolves with 16kHz mono PCM. */
  stop(): Promise<Float32Array>;
  /** Stops and tears down without producing audio (e.g. aborted mid-hold). */
  cancel(): void;
}

export async function startRecording(): Promise<VoiceRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : undefined;
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.addEventListener('dataavailable', (ev) => {
    if (ev.data.size > 0) chunks.push(ev.data);
  });
  recorder.start();

  function teardown(): void {
    stream.getTracks().forEach((track) => track.stop());
    source.disconnect();
    void audioCtx.close();
  }

  async function stop(): Promise<Float32Array> {
    if (recorder.state !== 'inactive') {
      const stopped = new Promise<void>((resolve) => recorder.addEventListener('stop', () => resolve(), { once: true }));
      recorder.stop();
      await stopped;
    }
    teardown();

    const blob = new Blob(chunks, { type: recorder.mimeType });
    const arrayBuffer = await blob.arrayBuffer();
    const decodeCtx = new AudioContext();
    const decoded = await decodeCtx.decodeAudioData(arrayBuffer);
    await decodeCtx.close();
    return resampleTo16kMono(decoded);
  }

  function cancel(): void {
    if (recorder.state !== 'inactive') recorder.stop();
    teardown();
  }

  return { analyser, stop, cancel };
}

// OfflineAudioContext constructed with 1 output channel performs the standard
// equal-weight stereo->mono downmix on connect, so there's no need to walk
// channels by hand — just render through it at the target rate.
async function resampleTo16kMono(buffer: AudioBuffer): Promise<Float32Array> {
  const frames = Math.ceil(buffer.duration * TARGET_SAMPLE_RATE);
  const offlineCtx = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
  const src = offlineCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(offlineCtx.destination);
  src.start(0);
  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0).slice();
}
