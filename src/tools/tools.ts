// Public surface of the tools layer. Registry + individual state modules live
// alongside this file; the agent loop consumes createTools() to get the model
// tool specs and a name -> Tool lookup.
export { createTools, READ_SIGN_PROMPT } from './registry';
export type { ToolRegistry, ToolContext, EngineForTools } from './registry';
export { setSimulatedFix, getFix } from './location';
export type { GpsFix } from './location';
export { setPendingFrame, takePendingFrame, hasPendingFrame } from './camera';
export { toMorse, morseTiming, morseDurationMs } from './morse';
export type { MorseStep } from './morse';
export { setPack, getPack, listPacks, defaultFixFor } from './pack';
export { runRouteBack, takePendingRoute, clearPackCache } from './route';
export type { PendingRoute } from './route';
