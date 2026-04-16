export class TypedEventEmitter<
  T extends Record<string, (...args: any[]) => void> = Record<string, (...args: any[]) => void>,
> {
  private listeners = new Map<keyof T, Set<Function>>();

  on<K extends keyof T>(event: K, listener: T[K]): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }

  off<K extends keyof T>(event: K, listener: T[K]): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit<K extends keyof T>(event: K, ...args: Parameters<T[K]>): void {
    this.listeners.get(event)?.forEach((fn) => {
      try {
        fn(...args);
      } catch (err) {
        process.stderr.write(
          `[registry] Event listener error (${String(event)}): ${err instanceof Error ? err.message : err}\n`
        );
      }
    });
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
