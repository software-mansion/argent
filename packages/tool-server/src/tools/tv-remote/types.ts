import type { RemoteButton } from "../../utils/vega-input";

export interface TvRemoteParams {
  udid: string;
  button: RemoteButton | RemoteButton[];
  repeat?: number;
}

export interface TvRemoteResult {
  pressed: RemoteButton[];
  count: number;
}

/** Flatten a single button / path × repeat into the concrete sequence to send. */
export function expandButtons(
  button: RemoteButton | RemoteButton[],
  repeat: number | undefined
): RemoteButton[] {
  const base = Array.isArray(button) ? button : [button];
  const n = Math.max(1, Math.floor(repeat ?? 1));
  return n === 1 ? base : Array.from({ length: n }, () => base).flat();
}
