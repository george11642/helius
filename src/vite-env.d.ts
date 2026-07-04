/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Overrides the model-mirror base URL main.ts otherwise picks by DEV/PROD. */
  readonly VITE_MODEL_BASE_URL?: string;
}
