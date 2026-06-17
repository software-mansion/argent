// simprofiler capture: drive coreprofilesessiontap on the booted sim via the
// host DTServiceHub (no xctrace), collect the raw kdebug stream to a file.
// usage: capture <udid> <seconds> <out.bin>
#import "conn.h"

int main(int argc, char **argv){
  setbuf(stdout,NULL);
  if(argc<4){ printf("usage: capture <udid> <seconds> <out.bin>\n"); return 1; }
  double secs = atof(argv[2]);
  @autoreleasepool{
    loadInstrumentsFrameworks();
    int spid=-1; id conn=connectLocalHub(&spid);
    printf("conn=%p serverPid=%d\n", conn, spid);
    if(!conn) return 2;
    ((void(*)(id,SEL))objc_msgSend)(conn, sel_registerName("resume"));
    ((void(*)(id,SEL,id))objc_msgSend)(conn, sel_registerName("_notifyOfPublishedCapabilities:"),
        (@{@"com.apple.private.DTXBlockCompression": @2, @"com.apple.private.DTXConnection": @1}));

    id ch = ((id(*)(id,SEL,id))objc_msgSend)(conn, sel_registerName("makeChannelWithIdentifier:"),
        @"com.apple.instruments.server.services.coreprofilesessiontap");
    printf("coreprofile channel=%p\n", ch);

    printf("a1: channel ok\n");
    NSString *outPath=[NSString stringWithUTF8String:argv[3]];
    [[NSFileManager defaultManager] createFileAtPath:outPath contents:nil attributes:nil];
    NSFileHandle *fh=[NSFileHandle fileHandleForWritingAtPath:outPath];
    printf("a2: file handle=%p\n", fh);

    __block long long totalBytes=0; __block int dataMsgs=0; __block int objMsgs=0;
    __block NSString *firstObj=nil; __block int anyMsg=0;
    void (^h)(id) = ^(id msg){
      anyMsg++;
      id data=((id(*)(id,SEL))objc_msgSend)(msg, sel_registerName("data"));
      id obj =((id(*)(id,SEL))objc_msgSend)(msg, sel_registerName("object"));
      unsigned long mt=((unsigned long(*)(id,SEL))objc_msgSend)(msg, sel_registerName("messageType"));
      if(anyMsg<=5) printf("[msg #%d] class=%s type=%lu dataLen=%lu obj=%s\n", anyMsg,
          object_getClassName(msg), mt,
          [data isKindOfClass:[NSData class]]?(unsigned long)[data length]:0,
          obj?object_getClassName(obj):"nil");
      if([data isKindOfClass:[NSData class]] && [data length]>0){
        dataMsgs++; totalBytes+=[data length];
        uint32_t len=(uint32_t)[data length];
        @try{ [fh writeData:[NSData dataWithBytes:&len length:4]]; [fh writeData:data]; }@catch(id e){}
      } else if(obj){ objMsgs++; if(!firstObj) firstObj=[obj description]; }
    };
    ((void(*)(id,SEL,id))objc_msgSend)(ch, sel_registerName("setMessageHandler:"), h);
    printf("a3: channel handler set\n");

    printf("A: handlers set, channel resumed\n");
    NSString *uuid=[[NSUUID UUID] UUIDString];
    printf("B: uuid=%s\n", uuid.UTF8String);
    // Periodic "Profile Every Thread" (PET) time trigger:
    //   tk=1  -> DTKPTriggerTime (periodic timer), NOT the kdebug-event trigger (tk=3,
    //            which only samples on syscalls/context-switches and so massively
    //            under-samples CPU-bound threads while over-sampling idle ones).
    //   si    -> sample interval in NANOSECONDS (1e6 = 1ms = 1kHz, matching xctrace's
    //            Time Profiler; clamped by the kernel to kperf.limits.timer_min_pet_period_ns).
    //   kdf2  -> restrict the kdebug typefilter to the PERF class (0x25) subclasses we
    //            actually parse (0x2500 PERF_Event, 0x2501 thread data, 0x2502 user stacks),
    //            instead of {0xFFFFFFFF} all-classes which floods the buffer (~130MB/s) and
    //            causes non-deterministic sample drops.
    long long si_ns = 1000000; // 1ms -> 1kHz
    const char *envSI = getenv("ARGENT_IOS_PROFILER_SI_NS");
    if (envSI && *envSI) { long long v = atoll(envSI); if (v > 0) si_ns = v; }
    NSDictionary *config = @{
      @"tc": @[ @{
        @"csd": @128,
        @"kdf2": [NSSet setWithObjects:@0x25000000u, @0x25010000u, @0x25020000u, nil],
        @"ta": @[ @[@3], @[@0], @[@2], @[@1,@1,@0] ],
        @"tk": @1,
        @"si": @(si_ns),
        @"uuid": uuid,
      } ],
      @"rp": @100,
      @"bm": @0,
    };
    printf("C: config built: %s\n", [[config description] UTF8String]);

    printf("sending setConfig: + start ...\n");
    ((void(*)(id,SEL,id,id))objc_msgSend)(ch, sel_registerName("sendMessage:replyHandler:"),
        DTXMsg1(sel_registerName("setConfig:"), config), ^(id r){
          id o=((id(*)(id,SEL))objc_msgSend)(r,sel_registerName("object"));
          printf("setConfig reply: %s\n", o?[[o description]UTF8String]:[[r description]UTF8String]); });
    ((void(*)(id,SEL,id,id))objc_msgSend)(ch, sel_registerName("sendMessage:replyHandler:"),
        DTXMsg0(sel_registerName("start")), ^(id r){
          id o=((id(*)(id,SEL))objc_msgSend)(r,sel_registerName("object"));
          printf("start reply: %s\n", o?[[o description]UTF8String]:[[r description]UTF8String]); });

    printf("collecting for %.1fs ...\n", secs);
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:secs]];

    ((void(*)(id,SEL,id,id))objc_msgSend)(ch, sel_registerName("sendMessage:replyHandler:"),
        DTXMsg0(sel_registerName("stop")), (id)nil);
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.3]];
    [fh closeFile];

    printf("\nRESULT: dataMsgs=%d objMsgs=%d totalBytes=%lld -> %s\n",
        dataMsgs, objMsgs, totalBytes, outPath.UTF8String);
    if(firstObj) printf("firstObj: %s\n", [firstObj.length>300?[firstObj substringToIndex:300]:firstObj UTF8String]);
    return totalBytes>0 ? 0 : 3;
  }
}
