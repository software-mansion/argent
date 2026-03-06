import * as p from "@clack/prompts";
import { activateWithLicenseKey, activateWithSSO, readToken } from "./license";

const LICENSE_KEY_REGEX = /^[0-9A-F]{4}(?:-[0-9A-F]{4}){7}$/i;

export async function runActivationTUI(): Promise<string | null> {
  p.intro("Radon Lite — License Required");
  p.note(
    "A tool was requested but no license token was found.\nPlease activate to continue.",
    "Activation needed"
  );

  const method = await p.select({
    message: "How would you like to activate?",
    options: [
      {
        value: "sso",
        label: "Login with SSO",
        hint: "recommended",
      },
      {
        value: "licenseKey",
        label: "Enter license key",
      },
      {
        value: "cancel",
        label: "Cancel",
      },
    ],
  });

  if (p.isCancel(method) || method === "cancel") {
    p.cancel("Cancelled — tool request will not complete.");
    return null;
  }

  if (method === "sso") {
    const spinner = p.spinner();
    spinner.start("Opening browser for SSO login...");

    const result = await activateWithSSO();

    if (!result.success) {
      if (result.ssoUrl) {
        spinner.stop("Could not open browser automatically.");
        p.note(result.ssoUrl, "Open this URL in your browser");
        // Re-run after user opens URL manually — but we can't wait for that here.
        // Just return null; the gate will be retriggered on the next tool call.
        p.cancel("Please open the URL above, then retry the tool.");
        return null;
      }
      spinner.stop(`SSO failed: ${result.error}`);
      p.cancel("Activation failed.");
      return null;
    }

    spinner.stop(`License activated! Plan: ${result.plan}`);
    p.outro("You can now use all Radon Lite tools.");
    return await readToken();
  }

  // License key path
  const licenseKey = await p.text({
    message: "Enter your license key:",
    placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX",
    validate: (v) =>
      LICENSE_KEY_REGEX.test(v ?? "") ? undefined : "Invalid format — expected XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX",
  });

  if (p.isCancel(licenseKey)) {
    p.cancel("Cancelled — tool request will not complete.");
    return null;
  }

  const spinner = p.spinner();
  spinner.start("Activating license...");

  const result = await activateWithLicenseKey(licenseKey as string);

  if (!result.success) {
    spinner.stop(`Activation failed: ${result.error}`);
    p.cancel("Please check your license key and try again.");
    return null;
  }

  spinner.stop(`License activated! Plan: ${result.plan}`);
  p.outro("You can now use all Radon Lite tools.");
  return readToken();
}

// ── Mutex: one TUI at a time ──────────────────────────────────────────────────

let activationInProgress: Promise<string | null> | null = null;

export function getOrStartActivation(): Promise<string | null> {
  if (!activationInProgress) {
    activationInProgress = runActivationTUI().finally(() => {
      activationInProgress = null;
    });
  }
  return activationInProgress;
}
