export interface Config {
  port: number;
  replay: boolean;
  showTouches: boolean;
}

export interface SessionSettings {
  replay: boolean;
  showTouches: boolean;
}

export interface SimulatorInfo {
  udid: string;
  name: string;
  state: string;
  deviceTypeId: string;
  runtimeId: string;
}

export interface Session {
  id: string;
  udid: string;
  streamUrl: string;
  state: "starting" | "ready" | "dead";
  createdAt: string;
  settings: SessionSettings;
}

export type TouchType = "Down" | "Up" | "Move";

export type DeviceOrientation =
  | "Portrait"
  | "LandscapeLeft"
  | "LandscapeRight"
  | "PortraitUpsideDown";

export type ButtonName =
  | "home"
  | "back"
  | "power"
  | "volumeUp"
  | "volumeDown"
  | "appSwitch"
  | "actionButton";

export interface ReplayResult {
  durationSecs: number | "full";
  url: string;
  filePath: string;
}

export interface VideoResult {
  durationSecs: number | "full";
  url: string;
  filePath: string;
}

export interface TokenVerifyResult {
  valid: boolean;
  plan?: string;
  features?: Record<string, string>;
  reason?: string;
}
