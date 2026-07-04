// Capability pre-flight: runs on the MAIN thread BEFORE any model bytes move.
// Probes WebGPU (adapter + the limits the q4f16 shards actually need), storage
// quota vs. the model footprint, persistence, and device-class signals, and
// returns a structured verdict the UI can act on:
//
//   'go'          — load the model normally.
//   'degraded'    — WebGPU exists but limits/RAM look marginal; a load MAY
//                   fail at compile. (No wasm fallback is offered: a ~3.2GB
//                   q4f16 multimodal stack is genuinely not viable under
//                   onnxruntime-web's wasm 4GB address space + CPU decode
//                   speeds — pretending otherwise just burns the user's data.)
//   'unsupported' — phone / low-memory / no WebGPU / not enough storage: the
//                   UI should steer to the native Helius Go app or map-only
//                   mode instead of starting a 3.2GB download that cannot end
//                   well.
//
// navigator.storage.persist() is requested here (main thread only — it is not
// available in workers) so the browser marks the origin's OPFS + caches as
// non-evictable (iOS Safari otherwise evicts after ~7 days of disuse).

import { measureResidentModelBytes } from './opfs-cache';
import type { CapabilityVerdict, DeviceCaps } from '../lib/contract';

export interface PreflightResult {
  verdict: CapabilityVerdict;
  caps: DeviceCaps;
}

// E2B q4f16 full multimodal footprint is ~3.2GB (measured on the live asset
// set); require headroom for manifests + decompression scratch.
const REQUIRED_STORAGE_BYTES = 3.6e9;
// Largest single external-data shard is ~1.5GB (embed_tokens_q4f16.onnx_data);
// individual GPU buffers are per-tensor and smaller, but adapters reporting
// tiny maxima will not survive session compile.
const GO_MAX_BUFFER = 1.5e9;
const GO_MAX_BINDING = 1e9;

const MB = (n: number | undefined): number | undefined =>
  n === undefined ? undefined : Math.round(n / 1e6);

interface GpuAdapterLike {
  limits?: { maxBufferSize?: number; maxStorageBufferBindingSize?: number };
}

function detectMobile(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  if (typeof nav.userAgentData?.mobile === 'boolean') return nav.userAgentData.mobile;
  const ua = navigator.userAgent;
  if (/iPhone|iPod|Android.*Mobile|Windows Phone|Mobi/i.test(ua)) return true;
  // iPadOS masquerades as desktop Safari on Mac; the touch-point count gives it away.
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return true;
  return false;
}

export async function runPreflight(): Promise<PreflightResult> {
  const reasons: string[] = [];

  // ---- WebGPU adapter + limits ---------------------------------------------
  let adapter: GpuAdapterLike | null = null;
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<GpuAdapterLike | null> } }).gpu;
    adapter = gpu ? await gpu.requestAdapter() : null;
  } catch {
    adapter = null;
  }
  const maxBufferSize = adapter?.limits?.maxBufferSize;
  const maxBinding = adapter?.limits?.maxStorageBufferBindingSize;

  // ---- storage --------------------------------------------------------------
  let quota: number | undefined;
  let usage: number | undefined;
  let persisted: boolean | undefined;
  try {
    const est = await navigator.storage?.estimate?.();
    quota = est?.quota;
    usage = est?.usage;
  } catch {
    /* estimate unsupported */
  }
  try {
    // Ask ONCE per boot; browsers either grant silently (installed PWA,
    // engagement) or deny silently — never a prompt on Chrome/Safari.
    persisted = (await navigator.storage?.persist?.()) ?? undefined;
  } catch {
    /* persist unsupported */
  }

  // ---- device class ----------------------------------------------------------
  const deviceMemoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const mobile = detectMobile();
  const modelResidentBytes = await measureResidentModelBytes();

  const caps: DeviceCaps = {
    webgpu: Boolean(adapter),
    maxBufferSizeMB: MB(maxBufferSize),
    maxStorageBufferBindingSizeMB: MB(maxBinding),
    storageQuotaMB: MB(quota),
    storageUsageMB: MB(usage),
    persisted,
    deviceMemoryGB,
    mobile,
    modelResidentMB: Math.round(modelResidentBytes / 1e6),
    reasons,
  };

  // ---- verdict ----------------------------------------------------------------
  if (!adapter) {
    reasons.push('WebGPU is unavailable in this browser — on-device Gemma needs a GPU-capable browser (map-only mode still works fully offline).');
    return { verdict: 'unsupported', caps };
  }

  // Storage: only binding if the weights are NOT already fully local.
  const stillNeeded = Math.max(0, REQUIRED_STORAGE_BYTES - modelResidentBytes);
  if (quota !== undefined && quota - (usage ?? 0) < stillNeeded) {
    reasons.push(
      `Not enough storage for the model (~${Math.round(stillNeeded / 1e9)}GB needed, ${Math.round(Math.max(0, quota - (usage ?? 0)) / 1e9)}GB available) — install the app to home screen for a bigger quota, use the native Helius Go app, or continue in map-only mode.`,
    );
    return { verdict: 'unsupported', caps };
  }

  if (mobile) {
    reasons.push('Phones cannot hold the on-device model in memory — use the native Helius Go app, or continue in map-only mode (maps, packs and routing work fully offline).');
    return { verdict: 'unsupported', caps };
  }

  if (deviceMemoryGB !== undefined && deviceMemoryGB <= 4) {
    reasons.push(`Device reports ${deviceMemoryGB}GB RAM — the on-device model needs more; map-only mode still works.`);
    return { verdict: 'unsupported', caps };
  }

  let degraded = false;
  if (maxBufferSize !== undefined && maxBufferSize < GO_MAX_BUFFER) {
    degraded = true;
    reasons.push(`GPU max buffer size is ${MB(maxBufferSize)}MB (large weight shards may fail to upload).`);
  }
  if (maxBinding !== undefined && maxBinding < GO_MAX_BINDING) {
    degraded = true;
    reasons.push(`GPU max storage-binding size is ${MB(maxBinding)}MB (model compile may fail).`);
  }
  if (persisted === false) {
    // Informational only — not a downgrade: the download still resumes even
    // if the browser later evicts, thanks to the OPFS manifest.
    reasons.push('Storage persistence was not granted; the browser may evict the model after long disuse (it will resume, not restart).');
  }

  return { verdict: degraded ? 'degraded' : 'go', caps };
}
