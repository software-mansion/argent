/**
 * Caveat for web URLs: nothing observes which app actually handled the URL, so a
 * silent browser fallback is indistinguishable from a real deep link in the
 * `opened: true` result.
 *
 * Custom-scheme URLs route to their registered app reliably, so they get none.
 */
export function httpDeepLinkNote(url: string): string | undefined {
  // No `//` required: browsers normalize `http:example.com` to `http://example.com`,
  // and no custom scheme starts with `http:`/`https:`.
  if (!/^https?:/i.test(url)) return undefined;
  return (
    "This is a web URL — it opens the native app only if an app installed on this device is " +
    "verified for the link's domain (iOS Universal Links / Android App Links); otherwise it " +
    "opens in the browser. On iOS simulators it may open in Safari even when the owning app is " +
    "installed. To reliably open an installed app, use its custom scheme (scheme://path) or " +
    "launch-app with its bundle id."
  );
}
