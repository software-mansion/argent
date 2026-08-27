export class TypedEventEmitter<
  T extends Record<string, (...args: any[]) => void> = Record<string, (...args: any[]) => void>,
> {
  private listeners = new Map<keyof T, Set<(...args: unknown[]) => void>>();

  on<K extends keyof T>(event: K, listener: T[K]): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }

  /**
   * @public
   * Every caller is in another workspace — tool-server (the variant-proposal
   * store, the chromium server's frame/fps and network listeners, both
   * js-runtime-debugger blueprints) and telemetry (`registry-listener`, which
   * detaches from `Registry.events`) — and the dead-code gate runs against an
   * unbuilt tree, where a cross-workspace edge cannot form. See `knip.jsonc`.
   *
   * To re-audit whether this tag is still earned, rename the member and read
   * the `Property 'off' does not exist` errors `tsc` reports. Do not grep
   * `.off(`: most hits in this repo are Node `EventEmitter`s.
   */
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
