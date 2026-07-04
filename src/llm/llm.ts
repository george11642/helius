// Model loading + inference runtime (Gemma 4 E2B via @huggingface/transformers,
// WebGPU). TODO: implement a loadLlmEngine() factory that streams weights in
// through src/workers/model-fetch.worker.ts and returns one of these.

export interface LlmEngine {
  generate(prompt: string): AsyncIterable<string>;
}
