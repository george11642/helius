// Tool registry: each Tool is a deterministic local function the agent can
// call by name (offline_map, route_back, sun_clock, read_sign, morse_beacon,
// ...). TODO: register real tools here as they're built in src/tools/.

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  schema: unknown; // TODO: JSON-schema describing this tool's call arguments
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

export const toolRegistry: Tool[] = [];
