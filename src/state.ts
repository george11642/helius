// Minimal typed event-emitter store. Feature modules publish state changes
// here (model load progress, GPS fix, active tool chain, ...) and the shell
// subscribes to re-render — keeps src/app/shell.ts framework-free.
// TODO: define the real AppState shape once agent/llm/map land, and swap this
// single-value Store for one instance per slice of state (or a small union).

type Listener<T> = (value: T) => void;

export class Store<T> {
  private value: T;
  private readonly listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    return this.value;
  }

  set(next: T): void {
    this.value = next;
    for (const listener of this.listeners) listener(next);
  }

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
