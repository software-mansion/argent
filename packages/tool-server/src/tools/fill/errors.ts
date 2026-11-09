import { FAILURE_CODES, FailureError } from "@argent/registry";
import { InvalidToolInputError } from "../../utils/capability";

// None of these messages may quote the requested text or the field's contents:
// either may be a credential, and an error travels further than a result
// (event log, telemetry, the caller's own logs).

export function noFocusedFieldError(stage: string): InvalidToolInputError {
  return new InvalidToolInputError(
    "Nothing that takes text has keyboard focus, so nothing was changed. Tap the text field " +
      "first, then call fill again.",
    {
      error_code: FAILURE_CODES.FILL_NO_FOCUSED_FIELD,
      failure_stage: stage,
      error_kind: "validation",
    }
  );
}

export function notVerifiedError(stage: string): FailureError {
  return new FailureError(
    "fill wrote to the focused field, but reading it back did not " +
      "show the requested text. The field may hold other or partial text: read it before " +
      "retrying.",
    {
      error_code: FAILURE_CODES.FILL_NOT_VERIFIED,
      failure_stage: stage,
      failure_area: "tool_server",
      error_kind: "unknown",
    }
  );
}

/** Same code as {@link notVerifiedError}, for a fill that changed nothing. */
export function notChangedError(stage: string): FailureError {
  return new FailureError(
    "fill could not select the text of the focused field, so nothing was changed. Tap the field " +
      "and retry.",
    {
      error_code: FAILURE_CODES.FILL_NOT_VERIFIED,
      failure_stage: stage,
      failure_area: "tool_server",
      error_kind: "unknown",
    }
  );
}

/** Same code as {@link notVerifiedError}: the device did not answer in time. */
export function notAnsweredError(stage: string): FailureError {
  return new FailureError(
    "The device did not finish the fill in time. The field may have changed: read it before " +
      "retrying.",
    {
      error_code: FAILURE_CODES.FILL_NOT_VERIFIED,
      failure_stage: stage,
      failure_area: "tool_server",
      error_kind: "timeout",
    }
  );
}

export function unsupportedFieldError(detail: string, stage: string): InvalidToolInputError {
  return new InvalidToolInputError(
    `fill cannot set this field's text: ${detail}. Nothing was changed.`,
    {
      error_code: FAILURE_CODES.FILL_UNSUPPORTED_FIELD,
      failure_stage: stage,
      error_kind: "unsupported",
    }
  );
}
