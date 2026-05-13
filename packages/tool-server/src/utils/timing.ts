export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_INTER_STEP_DELAY_MS = 100;
