/**
 * Wraps an agent's expression so that a module failing to load while it runs
 * throws back to the agent instead of opening a red box in the app.
 *
 * Metro loads a module through `guardedLoadModule`, which catches a throw from
 * the module's top-level code, hands it to `ErrorUtils.reportFatalError` (the
 * red box) and returns `undefined`. An expression that reads a lazy export,
 * such as `PushNotificationIOS` from `react-native`, whose native module the
 * app does not link, would then open the red box on every call and leave the
 * agent with an unrelated TypeError. While the expression runs synchronously,
 * the wrapper records such errors instead of reporting them, and throws the
 * first one once it ends. Errors from code that runs later, such as a render
 * the expression schedules, still reach the red box.
 *
 * The expression may read or replace `reportFatalError`, for example to hook
 * the red box. A reference it keeps to the recorder reports to the red box once
 * the expression ends, and a function it assigns stays in place.
 *
 * The expression runs through an indirect eval, which keeps the semantics of
 * `Runtime.evaluate`: global scope, the completion value, and a returned promise
 * awaited by CDP. A runtime without `ErrorUtils` evaluates it unchanged.
 */
export function guardModuleLoadErrors(expression: string): string {
  return `(function(source) {
  var g = typeof globalThis !== 'undefined' ? globalThis : this;
  var EU = g.ErrorUtils;
  if (!EU || typeof EU.reportFatalError !== 'function') return (0, eval)(source);
  var report = EU.reportFatalError;
  var fatal = [];
  var running = true;
  var record = function() {
    if (!running) return report.apply(this, arguments);
    fatal.push(arguments[0]);
  };
  EU.reportFatalError = record;
  var value;
  try {
    value = (0, eval)(source);
  } catch (e) {
    if (!fatal.length) throw e;
  } finally {
    running = false;
    if (EU.reportFatalError === record) EU.reportFatalError = report;
  }
  if (fatal.length) throw fatal[0];
  return value;
})(${JSON.stringify(expression)})`;
}
