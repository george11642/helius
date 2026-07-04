// Shared contract between the LLM/agent layer and the UI layer.
// Both sides import ONLY from this file (and state.ts) — no cross-imports.

// ---------- Engine ----------

export type ModelTier = 'E2B' | 'E4B';

export type EngineStatus =
  | { state: 'idle' }
  | { state: 'downloading'; pct: number; file?: string; mbDone?: number; mbTotal?: number }
  | { state: 'compiling' } // WebGPU shader/session build after files are local
  | { state: 'ready'; tier: ModelTier; loadMs: number }
  | { state: 'error'; message: string };

export interface GenerateRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxNewTokens?: number;
  /** raw Float32Array mono 16kHz — native Gemma 4 audio tokens (spike-verified) */
  audio?: Float32Array;
}

export interface GenerateResult {
  text: string;          // full decoded new text (special tokens stripped)
  rawText: string;       // with special tokens (tool-call parsing happens on this)
  nTokens: number;
  prefillMs: number;
  decodeTps: number;
}

// ---------- Chat / agent ----------

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | UserContentPart[] }
  | { role: 'assistant'; content?: string; tool_calls?: AssistantToolCall[] }
  // SPIKE-VERIFIED SHAPES (jinja engine quirks — do not change):
  // assistant tool_calls arguments MUST be an object; tool content MUST be a JSON string.
  | { role: 'tool'; name: string; content: string };

export type UserContentPart = { type: 'text'; text: string } | { type: 'audio' };

export interface AssistantToolCall {
  type: 'function';
  function: { name: string; arguments: Record<string, unknown> };
}

// ---------- Tools ----------

export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  };
}

export interface ToolResult {
  /** JSON-serializable payload — the agent loop stringifies it for role:'tool' content */
  data: Record<string, unknown>;
  /** short human line for the tool-trace UI, e.g. "fix 35.1983,-106.4439 ±14m" */
  summary: string;
}

export interface Tool {
  spec: ToolSpec;
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

// ---------- Agent events (UI subscribes; agent loop emits) ----------

export type AgentEvent =
  | { type: 'engine-status'; status: EngineStatus }
  | { type: 'user-message'; text: string }                       // echoed (incl. voice transcript)
  | { type: 'assistant-token'; text: string }                    // streaming visible text
  | { type: 'assistant-done'; text: string; stats: { decodeTps: number; prefillMs: number } }
  | { type: 'tool-start'; call: { name: string; args: Record<string, unknown> }; step: number }
  | { type: 'tool-done'; name: string; summary: string; ms: number; step: number }
  | { type: 'tool-error'; name: string; message: string; step: number }
  | { type: 'agent-turn-start' }
  | { type: 'agent-turn-done' }
  | { type: 'speak'; text: string }                              // TTS layer picks this up
  | { type: 'route'; geojson: unknown; distanceM: number; etaMin: number } // map layer draws
  | { type: 'beacon'; action: 'arm' | 'start' | 'stop'; pattern?: string };

export type AgentEventHandler = (e: AgentEvent) => void;
