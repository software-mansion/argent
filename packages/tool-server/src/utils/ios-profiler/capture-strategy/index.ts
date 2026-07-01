export type { IosCaptureStrategy, CaptureTarget, RecordArgsInput } from "./types";
export { deviceStrategy } from "./device";
export { allProcessesStrategy } from "./all-processes";
export {
  selectIosCaptureStrategy,
  resolveIosCaptureStrategy,
  type CaptureStrategyDecision,
  type CaptureStrategyReason,
} from "./select";
