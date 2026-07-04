// A single most-recent camera frame, stashed by the UI so the model can invoke
// `read_sign` mid-conversation (text turn) and still get a real image. The
// primary path is the façade's readSign() which runs vision directly; this
// covers the "model decides to read a sign" case. One-shot: taking it clears it.

import type { RawFrame } from '../llm/protocol';

let pendingFrame: RawFrame | null = null;

export function setPendingFrame(frame: RawFrame | null): void {
  pendingFrame = frame;
}

export function takePendingFrame(): RawFrame | null {
  const f = pendingFrame;
  pendingFrame = null;
  return f;
}

export function hasPendingFrame(): boolean {
  return pendingFrame !== null;
}
