/**
 * An https:// (or http://) URL only reaches a native app when that app is
 * installed and verified for the link's domain (iOS Universal Links / Android
 * App Links). Otherwise the system opens it in the browser — and on iOS
 * simulators `simctl openurl` routes Universal Links to Safari even when the
 * owning app *is* installed, which is a long-standing simulator limitation.
 *
 * The tool has no reliable way to observe which app actually handled the URL
 * (Safari and other apps are invisible to the native-devtools socket), so a web
 * URL that silently fell back to the browser looks identical to a successful
 * deep-link in the result. This caveat makes that ambiguity explicit to the
 * caller instead of letting `opened: true` imply the native app was reached.
 *
 * Returns undefined for custom-scheme URLs (`scheme://…`), which route to their
 * registered app reliably and need no caveat.
 */
export function httpDeepLinkNote(url: string): string | undefined {
  if (!/^https?:\/\//i.test(url)) return undefined;
  return (
    "This is a web URL — it opens the native app only if an app installed on this device is " +
    "verified for the link's domain (iOS Universal Links / Android App Links); otherwise it " +
    "opens in the browser. On iOS simulators it may open in Safari even when the owning app is " +
    "installed. To reliably open an installed app, use its custom scheme (scheme://path) or " +
    "launch-app with its bundle id."
  );
}
