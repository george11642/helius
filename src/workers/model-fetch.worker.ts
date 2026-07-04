// Dedicated worker: chunked Range-request download of LLM weights straight
// into OPFS (Origin Private File System), so multi-GB model shards never
// touch the Service Worker cache (see docs/ARCHITECTURE.md) and never block
// the main thread. TODO: implement the fetch+OPFS-write loop and
// postMessage() progress back to the caller.

export {};
