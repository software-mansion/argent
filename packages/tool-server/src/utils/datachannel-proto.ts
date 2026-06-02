import protobuf from "protobufjs";

/**
 * Vendored copy of `radon-cloud/packages/simulator-server/proto/datachannel.proto`.
 * Kept inline so we don't need a build step to ship the .proto file alongside
 * the compiled tool-server. If you bump the simulator-server schema, regenerate
 * this string from the canonical .proto.
 */
const PROTO_SOURCE = `
syntax = "proto3";

package datachannel;

enum TouchAction {
  TOUCH_DOWN = 0;
  TOUCH_UP = 1;
  TOUCH_MOVE = 2;
}

enum KeyAction {
  KEY_DOWN = 0;
  KEY_UP = 1;
}

enum ButtonType {
  BUTTON_HOME = 0;
  BUTTON_BACK = 1;
  BUTTON_POWER = 2;
  BUTTON_VOLUME_UP = 3;
  BUTTON_VOLUME_DOWN = 4;
  BUTTON_APP_SWITCH = 5;
  BUTTON_ACTION = 6;
}

enum RotateDirection {
  ROTATE_PORTRAIT = 0;
  ROTATE_PORTRAIT_UPSIDE_DOWN = 1;
  ROTATE_LANDSCAPE_LEFT = 2;
  ROTATE_LANDSCAPE_RIGHT = 3;
}

message TouchCommand {
  TouchAction action = 1;
  double x = 2;
  double y = 3;
  optional double second_x = 4;
  optional double second_y = 5;
}

message KeyCommand {
  KeyAction action = 1;
  int32 code = 2;
}

message ButtonCommand {
  KeyAction action = 1;
  ButtonType button = 2;
}

message RotateCommand {
  RotateDirection direction = 1;
}

message WheelCommand {
  double x = 1;
  double y = 2;
  double dx = 3;
  double dy = 4;
}

enum DownscalerType {
  DOWNSCALER_LANCZOS3 = 0;
  DOWNSCALER_BOX = 1;
  DOWNSCALER_BILINEAR = 2;
  DOWNSCALER_NEAREST = 3;
}

message ScreenshotCommand {
  optional string id = 1;
  optional RotateDirection rotation = 2;
  optional float scale = 3;
  optional DownscalerType downscaler = 4;
}

message DataChannelCommand {
  oneof command {
    TouchCommand touch = 1;
    KeyCommand key = 2;
    ButtonCommand button = 3;
    RotateCommand rotate = 4;
    WheelCommand wheel = 5;
    ScreenshotCommand screenshot = 6;
  }
}
`;

const root = protobuf.parse(PROTO_SOURCE, { keepCase: false }).root;
const DataChannelCommand = root.lookupType("datachannel.DataChannelCommand");

// Enum value lookups, named by their enum identifier inside the .proto so the
// public API can be friendly strings without leaking protobufjs internals.

const TouchAction = root.lookupEnum("datachannel.TouchAction").values;
const KeyAction = root.lookupEnum("datachannel.KeyAction").values;
const ButtonType = root.lookupEnum("datachannel.ButtonType").values;
const RotateDirection = root.lookupEnum("datachannel.RotateDirection").values;

export type TouchActionName = "Down" | "Up" | "Move";
export type KeyActionName = "Down" | "Up";
export type ButtonName =
  | "home"
  | "back"
  | "power"
  | "volumeUp"
  | "volumeDown"
  | "appSwitch"
  | "actionButton";
export type RotationName = "Portrait" | "PortraitUpsideDown" | "LandscapeLeft" | "LandscapeRight";

const TOUCH_ACTION: Record<TouchActionName, number> = {
  Down: TouchAction.TOUCH_DOWN ?? 0,
  Up: TouchAction.TOUCH_UP ?? 1,
  Move: TouchAction.TOUCH_MOVE ?? 2,
};

const KEY_ACTION: Record<KeyActionName, number> = {
  Down: KeyAction.KEY_DOWN ?? 0,
  Up: KeyAction.KEY_UP ?? 1,
};

const BUTTON_TYPE: Record<ButtonName, number> = {
  home: ButtonType.BUTTON_HOME ?? 0,
  back: ButtonType.BUTTON_BACK ?? 1,
  power: ButtonType.BUTTON_POWER ?? 2,
  volumeUp: ButtonType.BUTTON_VOLUME_UP ?? 3,
  volumeDown: ButtonType.BUTTON_VOLUME_DOWN ?? 4,
  appSwitch: ButtonType.BUTTON_APP_SWITCH ?? 5,
  actionButton: ButtonType.BUTTON_ACTION ?? 6,
};

const ROTATION: Record<RotationName, number> = {
  Portrait: RotateDirection.ROTATE_PORTRAIT ?? 0,
  PortraitUpsideDown: RotateDirection.ROTATE_PORTRAIT_UPSIDE_DOWN ?? 1,
  LandscapeLeft: RotateDirection.ROTATE_LANDSCAPE_LEFT ?? 2,
  LandscapeRight: RotateDirection.ROTATE_LANDSCAPE_RIGHT ?? 3,
};

function encode(payload: Record<string, unknown>): Uint8Array {
  const message = DataChannelCommand.create(payload);
  return DataChannelCommand.encode(message).finish();
}

export function encodeTouch(opts: {
  action: TouchActionName;
  x: number;
  y: number;
  secondX?: number;
  secondY?: number;
}): Uint8Array {
  const touch: Record<string, unknown> = {
    action: TOUCH_ACTION[opts.action],
    x: opts.x,
    y: opts.y,
  };
  if (opts.secondX !== undefined) touch.secondX = opts.secondX;
  if (opts.secondY !== undefined) touch.secondY = opts.secondY;
  return encode({ touch });
}

export function encodeKey(opts: { action: KeyActionName; code: number }): Uint8Array {
  return encode({
    key: { action: KEY_ACTION[opts.action], code: opts.code },
  });
}

export function encodeButton(opts: { action: KeyActionName; button: ButtonName }): Uint8Array {
  return encode({
    button: { action: KEY_ACTION[opts.action], button: BUTTON_TYPE[opts.button] },
  });
}

export function encodeRotate(direction: RotationName): Uint8Array {
  return encode({ rotate: { direction: ROTATION[direction] } });
}

export function encodeScreenshot(opts?: {
  id?: string;
  rotation?: RotationName;
  scale?: number;
}): Uint8Array {
  const screenshot: Record<string, unknown> = {};
  if (opts?.id !== undefined) screenshot.id = opts.id;
  if (opts?.rotation !== undefined) screenshot.rotation = ROTATION[opts.rotation];
  if (opts?.scale !== undefined) screenshot.scale = opts.scale;
  return encode({ screenshot });
}

export function encodeWheel(opts: { x: number; y: number; dx: number; dy: number }): Uint8Array {
  return encode({ wheel: { x: opts.x, y: opts.y, dx: opts.dx, dy: opts.dy } });
}
