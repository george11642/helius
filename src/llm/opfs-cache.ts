// Resumable model storage: chunked Range→OPFS downloads behind a
// transformers.js custom-cache façade (env.useCustomCache/env.customCache).
//
// WHY (verified against node_modules/@huggingface/transformers/src/utils):
// transformers.js's default browser path (`env.useBrowserCache`) does a
// whole-file GET and only cache.put()s the response once a shard is 100%
// complete — on iOS Safari a tab suspension mid-download of a multi-GB shard
// loses ALL progress, so the model "never finishes" on phones/flaky networks.
// The library's pluggable alternative is a custom cache object implementing
// `match(key)` / `put(key, response)` (checked in utils/cache.js getCache();
// keys probed are the localPath first, then the remote URL — utils/hub.js
// buildResourcePaths/checkCachedResource). We implement `match` so that a
// requested file is *downloaded resumably into OPFS* (streaming Range GET,
// bytes flushed to disk incrementally, a sidecar manifest tracking
// etag/size/bytes-done) and then served back from OPFS. A reload mid-download
// resumes from the manifest instead of restarting.
//
// Layout (OPFS root):
//   model-cache/<url path under modelBaseUrl>            raw bytes (may be partial)
//   model-cache/<...>.meta.json                          {url, etag, total, done}
//
// A file is complete iff meta.done === meta.total and the etag still matches
// on the next resume probe. R2 and the dev mirror both support Range (206) —
// verified live, including the CORS preflight for `range, if-range` on R2.
//
// This module is imported by the LLM worker (sync access handles need a
// dedicated worker); `measureResidentModelBytes` is also safe on the main
// thread (async OPFS reads only) for the pre-flight gate.

// ---- minimal OPFS typings (tsconfig lib is ES2022+DOM; sync access handles
// ---- are webworker-lib-only, and we keep the project DOM-lib-clean) --------
interface SyncAccessHandle {
  write(buffer: ArrayBufferView | ArrayBuffer, options?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
  getSize(): number;
}
interface OpfsFileHandle {
  getFile(): Promise<File>;
  createSyncAccessHandle(): Promise<SyncAccessHandle>;
}
interface OpfsDirHandle {
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<OpfsDirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<[string, unknown]>;
}

const ROOT_DIR = 'model-cache';
const META_SUFFIX = '.meta.json';
/** Negative-cache marker for a URL that 404'd — consulted only while OFFLINE
 *  (an offline reload must not spend the retry budget probing files that were
 *  simply absent upstream; online we always re-probe in case they appear). */
const NOT_FOUND_SUFFIX = '.404';
/** Persist the manifest at least this often while streaming (bytes). */
const META_FLUSH_BYTES = 8 * 1024 * 1024;
/** Abort a stalled response stream after this long with no bytes. */
const STALL_MS = 30_000;
const MAX_ATTEMPTS = 6;
/** Cap concurrent file downloads (4 weight shards would otherwise race). */
const MAX_CONCURRENT = 3;

interface FileMeta {
  url: string;
  etag: string; // validator: ETag > Last-Modified > String(total)
  total: number;
  done: number;
}

export interface DownloadProgress {
  /** Path of the file under the model base URL, e.g. 'gemma-4-e2b-onnx/onnx/decoder_model_merged_q4f16.onnx'. */
  file: string;
  fileLoaded: number;
  fileTotal: number;
  /** Aggregate over every file requested so far this session (grows as files are discovered). */
  overallLoaded: number;
  overallTotal: number;
  filesDone: number;
  filesTotal: number;
}

export interface OpfsModelCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  /** True while at least one network download is in flight. */
  busy(): boolean;
  /** Drop small config/template entries (.json/.jinja) so a poisoned config can be re-fetched. */
  purgeSmallFiles(): Promise<number>;
}

function getOpfsRoot(): Promise<OpfsDirHandle> {
  const storage = (navigator as Navigator & { storage?: { getDirectory?: () => Promise<unknown> } }).storage;
  if (!storage?.getDirectory) return Promise.reject(new Error('OPFS unavailable'));
  return storage.getDirectory() as unknown as Promise<OpfsDirHandle>;
}

/** Split a base-relative path into sanitized OPFS segments. */
function segmentsOf(rel: string): string[] {
  const segs = rel.split('/').filter((s) => s.length > 0 && s !== '.' && s !== '..');
  if (segs.length === 0) throw new Error(`bad cache path: ${rel}`);
  return segs;
}

async function dirFor(segs: string[], create: boolean): Promise<OpfsDirHandle> {
  let dir = await getOpfsRoot();
  dir = await dir.getDirectoryHandle(ROOT_DIR, { create });
  for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s, { create });
  return dir;
}

async function readMeta(dir: OpfsDirHandle, name: string): Promise<FileMeta | null> {
  try {
    const fh = await dir.getFileHandle(name + META_SUFFIX);
    const parsed: unknown = JSON.parse(await (await fh.getFile()).text());
    const m = parsed as FileMeta;
    if (typeof m.total === 'number' && typeof m.done === 'number' && typeof m.etag === 'string') return m;
    return null;
  } catch {
    return null;
  }
}

async function writeMeta(dir: OpfsDirHandle, name: string, meta: FileMeta): Promise<void> {
  const fh = await dir.getFileHandle(name + META_SUFFIX, { create: true });
  const handle = await fh.createSyncAccessHandle();
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(meta));
    handle.truncate(0);
    handle.write(bytes, { at: 0 });
    handle.flush();
  } finally {
    handle.close();
  }
}

/** Validator for a probe/response: ETag, else Last-Modified, else the size. */
function validatorOf(headers: Headers, total: number): string {
  return headers.get('etag') ?? headers.get('last-modified') ?? String(total);
}

/** Thrown for a 404 so match() can return undefined (transformers.js handles optional files itself). */
class NotFoundError extends Error {}

/** True when the browser KNOWS there is no network. Retrying/backing off in
 *  that state just stalls an offline boot for minutes — fail fast instead. */
function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function createOpfsModelCache(
  baseUrl: string,
  onProgress: (p: DownloadProgress) => void,
): OpfsModelCache {
  // Per-file progress ledger for the aggregate numbers. Includes files that
  // were already complete on disk (loaded === total) so overall % is honest
  // across resumes.
  const ledger = new Map<string, { loaded: number; total: number }>();
  const inflight = new Map<string, Promise<void>>();
  let activeDownloads = 0;

  // ---- tiny semaphore -------------------------------------------------------
  let slots = MAX_CONCURRENT;
  const waiters: Array<() => void> = [];
  const acquire = (): Promise<void> =>
    slots > 0 ? (slots--, Promise.resolve()) : new Promise((r) => waiters.push(r));
  const release = (): void => {
    const next = waiters.shift();
    if (next) next();
    else slots++;
  };

  function emit(rel: string): void {
    let overallLoaded = 0;
    let overallTotal = 0;
    let filesDone = 0;
    for (const f of ledger.values()) {
      overallLoaded += f.loaded;
      overallTotal += f.total;
      if (f.total > 0 && f.loaded >= f.total) filesDone++;
    }
    const cur = ledger.get(rel) ?? { loaded: 0, total: 0 };
    onProgress({
      file: rel,
      fileLoaded: cur.loaded,
      fileTotal: cur.total,
      overallLoaded,
      overallTotal,
      filesDone,
      filesTotal: ledger.size,
    });
  }

  function relOf(key: string): string | null {
    if (typeof key !== 'string' || !key.startsWith(baseUrl)) return null;
    const rel = key.slice(baseUrl.length).replace(/^\/+/, '');
    return rel.length > 0 ? rel : null;
  }

  /** Probe size+validator with a 1-byte Range GET (same trick transformers.js
   *  uses: content-range carries the true uncompressed size; also gets us the
   *  ETag). Falls back to HEAD content-length when the CORS policy doesn't
   *  expose content-range (content-length is CORS-safelisted; the model hosts
   *  serve raw binaries, so it matches the byte size). */
  async function probe(url: string): Promise<{ total: number; etag: string }> {
    // Both probe requests carry a hard timeout: a connection that stalls mid
    // probe would otherwise hang the whole load forever (fetch has no default
    // timeout), with no stream watchdog to save it.
    const resp = await fetch(url, {
      headers: { Range: 'bytes=0-0' },
      cache: 'no-store',
      signal: AbortSignal.timeout(STALL_MS),
    });
    if (resp.status === 404) throw new NotFoundError(url);
    if (!resp.ok && resp.status !== 206) throw new Error(`probe ${url}: HTTP ${resp.status}`);

    if (resp.status === 206) {
      const m = /\/(\d+)\s*$/.exec(resp.headers.get('content-range') ?? '');
      void resp.body?.cancel().catch(() => undefined);
      if (m) {
        const total = Number(m[1]);
        return { total, etag: validatorOf(resp.headers, total) };
      }
      // 206 but content-range not CORS-exposed — fall through to HEAD.
    } else {
      // Server ignored Range (plain 200) — content-length is the size.
      const total = Number(resp.headers.get('content-length') ?? NaN);
      void resp.body?.cancel().catch(() => undefined);
      if (Number.isFinite(total)) return { total, etag: validatorOf(resp.headers, total) };
    }

    const head = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(STALL_MS) });
    if (head.status === 404) throw new NotFoundError(url);
    if (!head.ok) throw new Error(`probe HEAD ${url}: HTTP ${head.status}`);
    const total = Number(head.headers.get('content-length') ?? NaN);
    if (!Number.isFinite(total)) throw new Error(`no readable size probing ${url}`);
    return { total, etag: validatorOf(head.headers, total) };
  }

  /** One-time migration: older builds stored complete shards in Cache Storage
   *  ('transformers-cache'). Copy a hit into OPFS instead of re-downloading
   *  gigabytes, then delete the legacy entry to reclaim the duplicate. */
  async function migrateFromLegacyCache(
    url: string,
    dir: OpfsDirHandle,
    name: string,
    rel: string,
  ): Promise<boolean> {
    if (typeof caches === 'undefined') return false;
    try {
      const legacy = await caches.open('transformers-cache');
      const hit = await legacy.match(url);
      if (!hit || !hit.body) return false;
      const total = Number(hit.headers.get('content-length') ?? NaN);
      const fh = await dir.getFileHandle(name, { create: true });
      const handle = await fh.createSyncAccessHandle();
      let done = 0;
      try {
        handle.truncate(0);
        const reader = hit.body.getReader();
        for (;;) {
          const { value, done: eof } = await reader.read();
          if (eof) break;
          handle.write(value, { at: done });
          done += value.byteLength;
        }
        handle.flush();
      } finally {
        handle.close();
      }
      if (Number.isFinite(total) && done !== total) {
        // Truncated legacy entry — poison, not progress. Drop both copies.
        await dir.removeEntry(name).catch(() => undefined);
        await legacy.delete(url).catch(() => undefined);
        return false;
      }
      await writeMeta(dir, name, { url, etag: validatorOf(hit.headers, done), total: done, done });
      ledger.set(rel, { loaded: done, total: done });
      void legacy.delete(url).catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }

  /** The core: make `rel` complete in OPFS, resuming from the manifest. */
  async function download(rel: string, url: string): Promise<void> {
    const segs = segmentsOf(rel);
    const name = segs[segs.length - 1];
    const dir = await dirFor(segs, true);

    // Already complete on disk?
    const existing = await readMeta(dir, name);
    if (existing && existing.done === existing.total && existing.total > 0) {
      ledger.set(rel, { loaded: existing.total, total: existing.total });
      return;
    }

    if (await migrateFromLegacyCache(url, dir, name, rel)) return;

    // Offline reload: a file not complete in OPFS cannot be fetched. If it was
    // negatively cached as a 404 last time we were online, report not-found
    // instantly (transformers.js tolerates optional files); otherwise fail the
    // probe fast below instead of burning ~60s of retry backoff per file.
    if (isOffline()) {
      const marked = await dir.getFileHandle(name + NOT_FOUND_SUFFIX).then(
        () => true,
        () => false,
      );
      if (marked) throw new NotFoundError(url);
    }

    // The initial probe gets the same retry treatment as the stream: a flaky
    // network at THIS point shouldn't fail the whole load either. A KNOWN-dead
    // network (navigator.onLine === false) is not flaky — fail immediately.
    let probed: { total: number; etag: string } | null = null;
    for (let pAttempt = 1; !probed; pAttempt++) {
      try {
        probed = await probe(url);
      } catch (err) {
        if (err instanceof NotFoundError) {
          // Negative-cache the 404 so an OFFLINE boot skips this file instantly.
          try {
            await dir.getFileHandle(name + NOT_FOUND_SUFFIX, { create: true });
          } catch {
            /* marker is best-effort */
          }
          throw err;
        }
        if (pAttempt >= MAX_ATTEMPTS || isOffline()) throw err;
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** Math.min(pAttempt, 5))));
      }
    }
    // The URL exists upstream — drop any stale negative-cache marker.
    void dir.removeEntry(name + NOT_FOUND_SUFFIX).catch(() => undefined);
    const { total, etag } = probed;
    const resuming = Boolean(existing && existing.etag === etag && existing.total === total && existing.done < total);
    let meta: FileMeta = resuming && existing ? existing : { url, etag, total, done: 0 };
    if (resuming) {
      console.info(`[helius] resuming download of ${rel} at ${meta.done}/${meta.total} bytes`);
    }

    ledger.set(rel, { loaded: meta.done, total });
    emit(rel);

    if (total === 0) {
      const fh = await dir.getFileHandle(name, { create: true });
      const h = await fh.createSyncAccessHandle();
      try {
        h.truncate(0);
        h.flush();
      } finally {
        h.close();
      }
      await writeMeta(dir, name, meta);
      return;
    }

    activeDownloads++;
    try {
      let attempt = 0;
      // Loop against the LIVE meta.total, not the initial probe's value: a
      // mid-download 200/If-Range-miss restart (streamOnce) or the revalidation
      // probe below can legitimately change the object size, and exiting at the
      // stale byte count would record a truncated file as complete (or 416-loop
      // forever against a smaller replacement).
      while (meta.done < meta.total) {
        attempt++;
        // Progress is judged by meta.done itself (streamOnce mutates it as
        // chunks land), NOT by whether the attempt resolved — a stream that
        // moved 300MB and then died must reset the retry budget too.
        const doneBefore = meta.done;
        await streamOnce(dir, name, rel, url, meta).catch((err) => {
          if (err instanceof NotFoundError) throw err;
          if (attempt >= MAX_ATTEMPTS || isOffline()) throw err;
        });
        if (meta.done >= meta.total) break;
        if (meta.done > doneBefore) attempt = 0; // flaky-but-moving network: keep going
        const backoff = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
        await new Promise((r) => setTimeout(r, backoff));
        // Revalidate before resuming — the object may have changed server-side.
        const re = await probe(url);
        if (re.etag !== meta.etag || re.total !== meta.total) {
          meta = { url, etag: re.etag, total: re.total, done: 0 };
          ledger.set(rel, { loaded: 0, total: re.total });
        }
      }
      await writeMeta(dir, name, meta);
      ledger.set(rel, { loaded: meta.total, total: meta.total });
      emit(rel);
    } finally {
      activeDownloads--;
    }
  }

  /** Single streaming attempt: open-ended Range from meta.done, write each
   *  chunk at its offset, flush, and persist the manifest as bytes land.
   *  Returns whether any bytes were persisted this attempt. */
  async function streamOnce(
    dir: OpfsDirHandle,
    name: string,
    rel: string,
    url: string,
    meta: FileMeta,
  ): Promise<boolean> {
    const controller = new AbortController();
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const armStall = () => {
      if (stallTimer !== null) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => controller.abort(new Error('download stalled')), STALL_MS);
    };

    armStall();
    // Only send If-Range when the validator is a real ETag or HTTP-date — a
    // fallback validator (String(total)) would always "mismatch" and force a
    // full 200 restart on every resume.
    const headers: Record<string, string> = { Range: `bytes=${meta.done}-` };
    if (/^(W\/)?"/.test(meta.etag) || /GMT$/.test(meta.etag)) headers['If-Range'] = meta.etag;
    const resp = await fetch(url, {
      headers,
      cache: 'no-store',
      signal: controller.signal,
    }).catch((err) => {
      if (stallTimer !== null) clearTimeout(stallTimer);
      throw err;
    });

    if (resp.status === 404) {
      if (stallTimer !== null) clearTimeout(stallTimer);
      throw new NotFoundError(url);
    }
    if (resp.status === 200) {
      // Server ignored Range or If-Range says the object changed: restart from 0.
      meta.done = 0;
      meta.etag = validatorOf(resp.headers, meta.total);
      const cl = Number(resp.headers.get('content-length') ?? NaN);
      if (Number.isFinite(cl)) meta.total = cl;
      ledger.set(rel, { loaded: 0, total: meta.total });
    } else if (resp.status === 206) {
      // Validate the range we ASKED for is the range we GOT — an edge/proxy
      // answering `bytes 0-…` to a resume request would otherwise be appended
      // at offset meta.done and silently corrupt the shard. content-range may
      // be CORS-hidden (then we can't check — same trust as before); when
      // visible, a mismatched start or total is a hard error → retry+reprobe.
      const cr = /bytes\s+(\d+)-\d+\/(\d+|\*)/i.exec(resp.headers.get('content-range') ?? '');
      if (cr && (Number(cr[1]) !== meta.done || (cr[2] !== '*' && Number(cr[2]) !== meta.total))) {
        if (stallTimer !== null) clearTimeout(stallTimer);
        void resp.body?.cancel().catch(() => undefined);
        throw new Error(`GET ${url}: content-range mismatch (${cr[0]}, expected start ${meta.done} of ${meta.total})`);
      }
    } else {
      if (stallTimer !== null) clearTimeout(stallTimer);
      throw new Error(`GET ${url}: HTTP ${resp.status}`);
    }
    if (!resp.body) {
      if (stallTimer !== null) clearTimeout(stallTimer);
      throw new Error(`GET ${url}: empty body`);
    }

    const fh = await dir.getFileHandle(name, { create: true });
    const handle = await fh.createSyncAccessHandle();
    const startDone = meta.done;
    let sinceMetaFlush = 0;
    try {
      // Fresh start (or forced restart): drop any stale bytes from a previous
      // object version so the finished file is exactly `total` bytes long.
      if (meta.done === 0 && handle.getSize() > 0) handle.truncate(0);
      const reader = resp.body.getReader();
      for (;;) {
        armStall();
        const { value, done: eof } = await reader.read();
        if (eof) break;
        handle.write(value, { at: meta.done });
        meta.done += value.byteLength;
        sinceMetaFlush += value.byteLength;
        ledger.set(rel, { loaded: meta.done, total: meta.total });
        if (sinceMetaFlush >= META_FLUSH_BYTES) {
          handle.flush();
          await writeMeta(dir, name, meta);
          sinceMetaFlush = 0;
        }
        emit(rel);
      }
      handle.flush();
    } finally {
      if (stallTimer !== null) clearTimeout(stallTimer);
      handle.close();
      await writeMeta(dir, name, meta).catch(() => undefined);
    }
    return meta.done > startDone;
  }

  function ensureDownloaded(rel: string, url: string): Promise<void> {
    let p = inflight.get(rel);
    if (!p) {
      p = (async () => {
        await acquire();
        try {
          await download(rel, url);
        } finally {
          release();
        }
      })().finally(() => inflight.delete(rel));
      inflight.set(rel, p);
    }
    return p;
  }

  return {
    async match(key: string): Promise<Response | undefined> {
      const rel = relOf(key);
      if (!rel) return undefined; // localPath probe or foreign key — let transformers.js move on
      try {
        await ensureDownloaded(rel, key);
      } catch (err) {
        if (err instanceof NotFoundError) return undefined;
        // Download genuinely failed (offline mid-way, quota, ...). Returning
        // undefined lets the caller's plain-fetch path produce the real error.
        console.warn('[helius] resumable download failed, falling back to plain fetch', key, err);
        return undefined;
      }
      const segs = segmentsOf(rel);
      const dir = await dirFor(segs, false);
      const file = await (await dir.getFileHandle(segs[segs.length - 1])).getFile();
      return new Response(file, {
        status: 200,
        headers: {
          'content-length': String(file.size),
          'content-type': 'application/octet-stream',
        },
      });
    },

    // Only reached if match() failed and transformers.js fetched the file
    // itself — persist that copy so next boot is still offline-capable.
    async put(key: string, response: Response): Promise<void> {
      try {
        const rel = relOf(key);
        if (!rel || !response.body) return;
        const segs = segmentsOf(rel);
        const name = segs[segs.length - 1];
        const dir = await dirFor(segs, true);
        const fh = await dir.getFileHandle(name, { create: true });
        const handle = await fh.createSyncAccessHandle();
        let done = 0;
        try {
          handle.truncate(0);
          const reader = response.body.getReader();
          for (;;) {
            const { value, done: eof } = await reader.read();
            if (eof) break;
            handle.write(value, { at: done });
            done += value.byteLength;
          }
          handle.flush();
        } finally {
          handle.close();
        }
        await writeMeta(dir, name, { url: key, etag: validatorOf(response.headers, done), total: done, done });
        ledger.set(rel, { loaded: done, total: done });
      } catch (err) {
        // Never let cache writes break a load that already has the bytes in memory.
        console.warn('[helius] opfs cache put failed', key, err);
      }
    },

    busy(): boolean {
      return activeDownloads > 0;
    },

    async purgeSmallFiles(): Promise<number> {
      let deleted = 0;
      try {
        const root = await getOpfsRoot();
        const base = await root.getDirectoryHandle(ROOT_DIR, { create: false });
        const walk = async (dir: OpfsDirHandle): Promise<void> => {
          for await (const [entryName, entry] of dir.entries()) {
            const isDir = (entry as { kind?: string }).kind === 'directory';
            if (isDir) {
              await walk(entry as OpfsDirHandle);
            } else {
              // Strip a manifest suffix first so 'decoder.onnx.meta.json'
              // (a WEIGHT manifest — deleting it would force a multi-GB
              // re-download) is judged by its underlying name, not '.json'.
              const underlying = entryName.replace(/\.meta\.json$/, '');
              if (/\.(json|jinja)$/.test(underlying)) {
                await dir.removeEntry(entryName).catch(() => undefined);
                deleted++;
              }
            }
          }
        };
        await walk(base);
      } catch {
        // no OPFS / nothing cached — nothing to purge
      }
      return deleted;
    },
  };
}

/** One-time cleanup of the pre-wave service-worker double-store: older builds'
 *  SW `.bin` rule also cached the multi-GB .onnx/.onnx_data weight shards in
 *  the 'ml-models' Cache Storage bucket (vite.config.ts now excludes them, but
 *  workbox never proactively evicts existing entries). Those copies are pure
 *  dead weight — the usable legacy copy lives in 'transformers-cache' and is
 *  migrated into OPFS by migrateFromLegacyCache — and on a storage-tight
 *  machine they inflate navigator.storage.estimate() usage enough to flip the
 *  pre-flight quota check to 'unsupported'. Main-thread-safe; returns entries
 *  deleted. The .wasm/.bin runtime entries that bucket legitimately holds are
 *  left alone. */
export async function cleanupLegacyWeightCache(): Promise<number> {
  let deleted = 0;
  if (typeof caches === 'undefined') return deleted;
  try {
    const bucket = await caches.open('ml-models');
    for (const req of await bucket.keys()) {
      if (/\.onnx(_data[^/?]*)?(\?|$)/.test(req.url)) {
        if (await bucket.delete(req)) deleted++;
      }
    }
  } catch {
    // Cache Storage unavailable — nothing stored, nothing to clean.
  }
  return deleted;
}

/** Bytes of COMPLETE model files resident in OPFS (main-thread-safe: async
 *  reads only). Used by the pre-flight gate: a device whose quota looks too
 *  small still gets a 'go' if the weights are already fully local.
 *  `subdir` scopes the sum to one tier's directory (e.g. 'gemma-4-e2b-onnx')
 *  so complete files of the OTHER tier can't masquerade as this tier being
 *  resident; omitted = everything under model-cache (legacy behavior). */
export async function measureResidentModelBytes(subdir?: string): Promise<number> {
  let bytes = 0;
  try {
    const root = await getOpfsRoot();
    let base = await root.getDirectoryHandle(ROOT_DIR, { create: false });
    if (subdir) base = await base.getDirectoryHandle(subdir, { create: false });
    const walk = async (dir: OpfsDirHandle): Promise<void> => {
      for await (const [entryName, entry] of dir.entries()) {
        if ((entry as { kind?: string }).kind === 'directory') {
          await walk(entry as OpfsDirHandle);
        } else if (entryName.endsWith(META_SUFFIX)) {
          try {
            const meta = JSON.parse(await (await (entry as OpfsFileHandle).getFile()).text()) as FileMeta;
            if (meta.total > 0 && meta.done === meta.total) bytes += meta.total;
          } catch {
            // unreadable meta — skip
          }
        }
      }
    };
    await walk(base);
  } catch {
    // no OPFS or nothing downloaded yet
  }
  return bytes;
}
