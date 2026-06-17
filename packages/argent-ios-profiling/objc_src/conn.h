// shared connect helper for the spike tools
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <dlfcn.h>
#import <Security/Authorization.h>

// +[DTXMessage messageWithSelector:(SEL) objectArguments:(id)firstObj, ...] — VARIADIC,
// nil-terminated. firstObj is a NAMED param (x3 on arm64), the rest are stack varargs.
// So the cast MUST have firstObj as a named id param BEFORE the `...`.
typedef id (*DTXMsgFn)(id, SEL, SEL, id, ...);
static inline id DTXMsg0(SEL s){
  return ((DTXMsgFn)objc_msgSend)((id)objc_getClass("DTXMessage"),
      sel_registerName("messageWithSelector:objectArguments:"), s, (id)nil); }
static inline id DTXMsg1(SEL s, id a){
  return ((DTXMsgFn)objc_msgSend)((id)objc_getClass("DTXMessage"),
      sel_registerName("messageWithSelector:objectArguments:"), s, a, (id)nil); }

static inline void loadInstrumentsFrameworks(void){
  const char *base = "/Applications/Xcode.app/Contents/SharedFrameworks"; char p[512];
  dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW);
  snprintf(p,sizeof p,"%s/DTXConnectionServices.framework/DTXConnectionServices",base); dlopen(p,RTLD_NOW);
  snprintf(p,sizeof p,"%s/DVTInstrumentsUtilities.framework/DVTInstrumentsUtilities",base); dlopen(p,RTLD_NOW);
  snprintf(p,sizeof p,"%s/DVTInstrumentsFoundation.framework/DVTInstrumentsFoundation",base); dlopen(p,RTLD_NOW);
}

static inline id simDeviceForUDID(const char *udid){
  NSError *err=nil;
  id ctx=((id(*)(id,SEL,id,NSError**))objc_msgSend)((id)objc_getClass("SimServiceContext"),
      sel_registerName("sharedServiceContextForDeveloperDir:error:"),@"/Applications/Xcode.app/Contents/Developer",&err);
  id ds=((id(*)(id,SEL,NSError**))objc_msgSend)(ctx,sel_registerName("defaultDeviceSetWithError:"),&err);
  NSArray *devs=((id(*)(id,SEL))objc_msgSend)(ds,sel_registerName("availableDevices"));
  NSString *want=[NSString stringWithUTF8String:udid];
  for(id d in devs){id u=((id(*)(id,SEL))objc_msgSend)(d,sel_registerName("UDID"));
    if([((id(*)(id,SEL))objc_msgSend)(u,sel_registerName("UUIDString")) caseInsensitiveCompare:want]==NSOrderedSame) return d;}
  return nil;
}

// Returns a resumed DTXConnection to a freshly spawned host DTServiceHub (or nil).
static inline id connectLocalHub(int *serverPidOut){
  AuthorizationRef auth=NULL; AuthorizationCreate(NULL,kAuthorizationEmptyEnvironment,kAuthorizationFlagDefaults,&auth);
  NSError *err=nil; int spid=-1;
  id conn=((id(*)(id,SEL,AuthorizationRef,int*,NSError**))objc_msgSend)((id)objc_getClass("DTServiceHubClient"),
      sel_registerName("localConnectionWithAuthorization:returningServerPid:error:"),auth,&spid,&err);
  if(serverPidOut)*serverPidOut=spid;
  return conn;
}
