// Chat panel: message list (streaming assistant text with a blink cursor,
// tiny hand-rolled markdown-lite, a refusal-style beat for the non-medical
// guardrail) + the input row (text + mic). Auto-scrolls pinned to the
// bottom unless the user has scrolled up to read history.

import type { AgentEvent } from '../lib/contract';
import { mountMic } from './voice';
import { mountCamera } from './camera';
import { escapeHtml } from './dom';

export interface ChatOptions {
  onSend(text: string): void;
  onAudio(samples: Float32Array): void;
  onReadSign(image: HTMLCanvasElement): void;
}

export interface ChatHandle {
  handleEvent(e: AgentEvent): void;
  setEnabled(enabled: boolean): void;
}

const REFUSAL_PATTERNS = [
  /^i\s*(cannot|can't|won't|am not able to)\s+(provide|give|offer)\s+medical/i,
  /^(this|that)\s+isn't medical advice/i,
  /^i'?m not (a )?(medical|doctor)/i,
];

function isRefusal(text: string): boolean {
  const trimmed = text.trim();
  return REFUSAL_PATTERNS.some((re) => re.test(trimmed));
}

function boldify(s: string): string {
  return s.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_m, a: string, b: string) => `<strong>${a ?? b}</strong>`);
}

// Tiny hand-rolled markdown-lite: bold + bullet lists only. Escapes HTML
// first so model output is never interpreted as markup, then layers our own
// minimal syntax on top. Newlines render as line breaks for free via the
// `white-space: pre-wrap` on .msg-bubble, so no <br> conversion needed.
function renderMarkdownLite(rawText: string): string {
  const lines = escapeHtml(rawText).split('\n');
  const out: string[] = [];
  let listBuffer: string[] = [];
  const flushList = () => {
    if (listBuffer.length) {
      out.push(`<ul>${listBuffer.map((item) => `<li>${boldify(item)}</li>`).join('')}</ul>`);
      listBuffer = [];
    }
  };
  for (const line of lines) {
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) listBuffer.push(bullet[1]);
    else {
      flushList();
      out.push(boldify(line));
    }
  }
  flushList();
  return out.join('\n');
}

export function mountChat(messagesEl: HTMLElement, inputRowEl: HTMLElement, opts: ChatOptions): ChatHandle {
  inputRowEl.innerHTML = `
    <textarea class="chat-input" rows="1" placeholder="Ask Helius…" disabled></textarea>
    <div class="camera-slot"></div>
    <div class="mic-slot"></div>
    <button type="button" class="chat-send-btn" disabled>Send</button>
  `;
  const textarea = inputRowEl.querySelector<HTMLTextAreaElement>('.chat-input')!;
  const sendBtn = inputRowEl.querySelector<HTMLButtonElement>('.chat-send-btn')!;
  const cameraSlot = inputRowEl.querySelector<HTMLElement>('.camera-slot')!;
  const micSlot = inputRowEl.querySelector<HTMLElement>('.mic-slot')!;

  const jumpPill = document.createElement('button');
  jumpPill.type = 'button';
  jumpPill.className = 'chat-jump-pill';
  jumpPill.textContent = '↓ new';
  jumpPill.hidden = true;
  // Positioned absolute against .chat-col (the nearest positioned ancestor —
  // see style.css), so it stays put regardless of where in the DOM it lives.
  messagesEl.parentElement!.appendChild(jumpPill);

  let pinnedToBottom = true;
  let lastInputWasVoice = false;
  // The real agent loop only emits 'user-message' for voice transcripts (the
  // UI has no other way to learn what was transcribed) — NOT for typed text,
  // since the loop already has that text directly from sendText(). Typed
  // messages are rendered optimistically on submit instead; this holds the
  // most recently submitted typed text so a 'user-message' echo (if one ever
  // does arrive for text, e.g. from the mock) doesn't double-render it.
  let pendingTypedEcho: string | null = null;
  let streamingBubble: HTMLElement | null = null;
  let streamingTextEl: HTMLElement | null = null;
  let thinkingEl: HTMLElement | null = null;

  function afterAppend(): void {
    if (pinnedToBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
      jumpPill.hidden = true;
    } else {
      jumpPill.hidden = false;
    }
  }

  messagesEl.addEventListener('scroll', () => {
    const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 24;
    pinnedToBottom = atBottom;
    if (atBottom) jumpPill.hidden = true;
  });

  jumpPill.addEventListener('click', () => {
    pinnedToBottom = true;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    jumpPill.hidden = true;
  });

  function removeThinking(): void {
    if (thinkingEl) {
      thinkingEl.remove();
      thinkingEl = null;
    }
  }

  function showThinking(): void {
    removeThinking();
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'msg msg-assistant msg-thinking';
    thinkingEl.innerHTML = `<div class="msg-bubble"><span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-dot"></span></div>`;
    messagesEl.appendChild(thinkingEl);
    afterAppend();
  }

  function appendUserMessage(text: string, viaVoice: boolean): void {
    removeThinking();
    const msg = document.createElement('div');
    msg.className = 'msg msg-user';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = text;
    msg.appendChild(bubble);
    if (viaVoice) {
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.innerHTML = `<span class="mic-tag">🎙 transcribed on-device</span>`;
      msg.appendChild(meta);
    }
    messagesEl.appendChild(msg);
    afterAppend();
  }

  function ensureStreamingBubble(): void {
    removeThinking();
    if (streamingBubble) return;
    const msg = document.createElement('div');
    msg.className = 'msg msg-assistant';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    const textSpan = document.createElement('span');
    textSpan.className = 'streaming-text';
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    cursor.textContent = '▍';
    bubble.append(textSpan, cursor);
    msg.appendChild(bubble);
    messagesEl.appendChild(msg);
    streamingBubble = msg;
    streamingTextEl = textSpan;
    afterAppend();
  }

  function appendToken(text: string): void {
    ensureStreamingBubble();
    streamingTextEl!.textContent += text;
    afterAppend();
  }

  function finalizeAssistant(text: string): void {
    ensureStreamingBubble();
    const msg = streamingBubble!;
    const bubble = msg.querySelector<HTMLElement>('.msg-bubble')!;
    const refusal = isRefusal(text);
    msg.classList.toggle('msg-refusal', refusal);
    bubble.innerHTML = (refusal ? '<span class="shield-glyph">🛡</span>' : '') + renderMarkdownLite(text);
    streamingBubble = null;
    streamingTextEl = null;
    afterAppend();
  }

  function handleEvent(e: AgentEvent): void {
    switch (e.type) {
      case 'user-message': {
        const viaVoice = lastInputWasVoice;
        lastInputWasVoice = false;
        if (!viaVoice && e.text === pendingTypedEcho) {
          // Already rendered optimistically in submit() — this is just an
          // echo of it, not a new message. Consume the guard and skip.
          pendingTypedEcho = null;
          break;
        }
        appendUserMessage(e.text, viaVoice);
        break;
      }
      case 'agent-turn-start':
        showThinking();
        break;
      case 'assistant-token':
        appendToken(e.text);
        break;
      case 'assistant-done':
        finalizeAssistant(e.text);
        break;
      case 'agent-turn-done':
        removeThinking();
        break;
      default:
        break;
    }
  }

  function submit(): void {
    if (sendBtn.disabled) return;
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    textarea.style.height = 'auto';
    lastInputWasVoice = false;
    pendingTypedEcho = text;
    appendUserMessage(text, false);
    opts.onSend(text);
  }

  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  });
  textarea.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      submit();
    }
  });
  sendBtn.addEventListener('click', submit);

  const micHandle = mountMic(micSlot, {
    onAudio: (samples) => {
      lastInputWasVoice = true;
      opts.onAudio(samples);
    },
  });

  const cameraHandle = mountCamera(cameraSlot, {
    onCapture: (image) => opts.onReadSign(image),
  });

  function setEnabled(enabled: boolean): void {
    textarea.disabled = !enabled;
    sendBtn.disabled = !enabled;
    micHandle.setEnabled(enabled);
    cameraHandle.setEnabled(enabled);
  }

  return { handleEvent, setEnabled };
}
