// Shared contract between the LLM/agent layer and the UI layer.
// Both sides import ONLY from this file (and state.ts) — no cross-imports.

// ---------- Engine ----------

export type ModelTier = 'E2B' | 'E4B';

/** Pre-flight capability verdict, emitted BEFORE any model bytes move. */
export type CapabilityVerdict = 'go' | 'degraded' | 'unsupported';

/** What the pre-flight probe actually saw (sizes rounded to MB/GB). */
export interface DeviceCaps {
  webgpu: boolean;
  maxBufferSizeMB?: number;
  maxStorageBufferBindingSizeMB?: number;
  storageQuotaMB?: number;
  storageUsageMB?: number;
  persisted?: boolean;
  deviceMemoryGB?: number;
  mobile: boolean;
  /** Complete model bytes already resident in OPFS (resume / repeat visit). */
  modelResidentMB: number;
  /** Human-readable reasons behind the verdict (empty for a clean 'go'). */
  reasons: string[];
}

export type EngineStatus =
  | { state: 'idle' } // engine constructed, no model load started (map-only mode)
  | { state: 'preflight'; verdict: CapabilityVerdict; caps: DeviceCaps } // capability probe result, pre-download
  | {
      state: 'downloading';
      /** Overall percent for the CURRENT stage (restarts at 0 when 'fetch' hands over to 'read'). */
      pct: number;
      /** 'fetch' = resumable network download into OPFS; 'read' = loading local bytes into the runtime. */
      stage?: 'fetch' | 'read';
      /** Current file (path under the model base URL). */
      file?: string;
      mbDone?: number;
      mbTotal?: number;
      /** Per-file progress for the file named above (fetch stage only). */
      fileMbDone?: number;
      fileMbTotal?: number;
      filesDone?: number;
      filesTotal?: number;
    }
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

// ---------- Region packs ----------

export interface PackInfo {
  id: string;
  name: string;
  bbox: [number, number, number, number]; // [west, south, east, north]
  center: [number, number];               // [lon, lat]
  totalBytes: number;
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
  // dest/display are authoritative pre-formatted values from the route tool so
  // the UI can render real numbers without trusting model prose. Optional =
  // additive: existing consumers of the original shape are unaffected.
  | { type: 'route'; geojson: unknown; distanceM: number; etaMin: number; dest?: string; display?: string } // map layer draws
  | { type: 'beacon'; action: 'arm' | 'start' | 'stop'; pattern?: string }
  | { type: 'pack-changed'; pack: PackInfo; fix: { lat: number; lon: number } }; // region switch

export type AgentEventHandler = (e: AgentEvent) => void;
