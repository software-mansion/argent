export interface NetworkConditions {
  latencyMs?: number;
  downloadKbps?: number;
  uploadKbps?: number;
  offline?: boolean;
}

/** Params of CDP `Network.emulateNetworkConditions`: throughput in bytes/s, -1 for unlimited. */
export type CdpNetworkConditions = {
  offline: boolean;
  latency: number;
  downloadThroughput: number;
  uploadThroughput: number;
};

const kbpsToBytesPerSecond = (kbps: number | undefined) => (kbps === undefined ? -1 : kbps * 125);

export function toCdpNetworkConditions(conditions: NetworkConditions | null): CdpNetworkConditions {
  return {
    offline: conditions?.offline ?? false,
    latency: conditions?.latencyMs ?? 0,
    downloadThroughput: kbpsToBytesPerSecond(conditions?.downloadKbps),
    uploadThroughput: kbpsToBytesPerSecond(conditions?.uploadKbps),
  };
}
