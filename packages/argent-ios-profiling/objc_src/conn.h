// shared connect helper for the spike tools
#import <Foundation/Foundation.h>
#import <Security/Authorization.h>
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>

// +[DTXMessage messageWithSelector:(SEL) objectArguments:(id)firstObj, ...] — VARIADIC,
// nil-terminated. firstObj is a NAMED param (x3 on arm64), the rest are stack varargs.
// So the cast MUST have firstObj as a named id param BEFORE the `...`.
typedef id (*DTXMsgFn)(id, SEL, SEL, id, ...);
static inline id DTXMsg0(SEL s) {
  return ((DTXMsgFn)objc_msgSend)((id)objc_getClass("DTXMessage"),
                                  sel_registerName("messageWithSelector:objectArguments:"), s,
                                  (id)nil);
}
static inline id DTXMsg1(SEL s, id a) {
  return ((DTXMsgFn)objc_msgSend)((id)objc_getClass("DTXMessage"),
                                  sel_registerName("messageWithSelector:objectArguments:"), s, a,
                                  (id)nil);
}

static inline void loadInstrumentsFrameworks(void) {
  const char *base = "/Applications/Xcode.app/Contents/SharedFrameworks";
  char p[512];
  dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW);
  snprintf(p, sizeof p, "%s/DTXConnectionServices.framework/DTXConnectionServices", base);
  dlopen(p, RTLD_NOW);
  snprintf(p, sizeof p, "%s/DVTInstrumentsUtilities.framework/DVTInstrumentsUtilities", base);
  dlopen(p, RTLD_NOW);
  snprintf(p, sizeof p, "%s/DVTInstrumentsFoundation.framework/DVTInstrumentsFoundation", base);
  dlopen(p, RTLD_NOW);
}

static inline id simDeviceForUDID(const char *udid) {
  NSError *err = nil;
  id ctx = ((id (*)(id, SEL, id, NSError **))objc_msgSend)(
      (id)objc_getClass("SimServiceContext"),
      sel_registerName("sharedServiceContextForDeveloperDir:error:"),
      @"/Applications/Xcode.app/Contents/Developer", &err);
  id ds = ((id (*)(id, SEL, NSError **))objc_msgSend)(
      ctx, sel_registerName("defaultDeviceSetWithError:"), &err);
  NSArray *devs = ((id (*)(id, SEL))objc_msgSend)(ds, sel_registerName("availableDevices"));
  NSString *want = [NSString stringWithUTF8String:udid];
  for (id d in devs) {
    id u = ((id (*)(id, SEL))objc_msgSend)(d, sel_registerName("UDID"));
    if ([((id (*)(id, SEL))objc_msgSend)(
            u, sel_registerName("UUIDString")) caseInsensitiveCompare:want] == NSOrderedSame)
      return d;
  }
  return nil;
}

// Returns a resumed DTXConnection to a DTServiceHub (or nil).
//
// Avenue A — prefer the DEVICE/simulator service-hub path
// (`+localDeviceConnectionWithError:returningServerPid:`). It connects through
// the CoreSimulator/device broker rather than spawning the *host* profiling hub
// (`+localConnectionWithAuthorization:…`), so it is NOT gated by the host
// Instruments arbiter (`com.apple.dt.instruments.dtarbiter`), which on
// SIP-enabled Macs rejects non-Apple-signed clients with -67050
// (errSecCSReqFailed / "code requirements not met"). It needs no AuthorizationRef.
// Since the iOS simulator runs on the host kernel, coreprofilesessiontap over this
// connection yields the same kdebug stream — no data loss. The legacy host path is
// kept as a fallback for environments where the device path is unavailable.
static inline id connectLocalHub(int *serverPidOut) {
  NSError *err = nil;
  int spid = -1;
  id conn = ((id (*)(id, SEL, NSError **, int *))objc_msgSend)(
      (id)objc_getClass("DTServiceHubClient"),
      sel_registerName("localDeviceConnectionWithError:returningServerPid:"), &err, &spid);
  if (conn) {
    if (serverPidOut) *serverPidOut = spid;
    return conn;
  }

  // Fallback: legacy host profiling hub (works on SIP-disabled / lenient-arbiter hosts).
  AuthorizationRef auth = NULL;
  AuthorizationCreate(NULL, kAuthorizationEmptyEnvironment, kAuthorizationFlagDefaults, &auth);
  err = nil;
  spid = -1;
  conn = ((id (*)(id, SEL, AuthorizationRef, int *, NSError **))objc_msgSend)(
      (id)objc_getClass("DTServiceHubClient"),
      sel_registerName("localConnectionWithAuthorization:returningServerPid:error:"), auth, &spid,
      &err);
  if (auth) AuthorizationFree(auth, kAuthorizationFlagDefaults);
  if (serverPidOut) *serverPidOut = spid;
  return conn;
}
