// Public surface of the LLM layer. The real engine (worker client) lives in
// engine.ts; the worker host is ../workers/llm.worker.ts.
export { createEngine, frameFromImage } from './engine';
export type { Engine, EngineResult, GenerateOptions } from './engine';
