import type { DeviceInfo, Registry } from "@argent/registry";
import { androidDevtoolsRef, type AndroidDevtoolsApi } from "../../blueprints/android-devtools";
import {
  noFocusedFieldError,
  notAnsweredError,
  notVerifiedError,
  unsupportedFieldError,
} from "./errors";
import type { FillResult } from "./types";

/**
 * Android phone or tablet. The devtools helper finds the input-focused node,
 * sets its text with ACTION_SET_TEXT and reads it back (a password by length),
 * answering only whether it matched.
 */
export async function fillAndroid(
  registry: Registry,
  device: DeviceInfo,
  text: string
): Promise<FillResult> {
  const ref = androidDevtoolsRef(device);
  const helper = await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
  const answer = await helper.setText(text);
  if (!answer.focused) throw noFocusedFieldError("fill_android_no_focus");
  if (answer.singleLine) {
    throw unsupportedFieldError(
      "a single-line text field cannot hold a newline",
      "fill_android_single_line"
    );
  }
  if (answer.timedOut) throw notAnsweredError("fill_android_timeout");
  if (answer.verified) return { verified: true };
  throw notVerifiedError("fill_android_not_verified");
}
