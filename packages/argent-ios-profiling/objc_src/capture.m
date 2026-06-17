// ios-profiler capture: drive coreprofilesessiontap on the booted sim via the
// host DTServiceHub (no xctrace), collect the raw kdebug stream to a file.
// usage: capture <udid> <seconds> <out.bin>
// stdout is intentionally silent (the kdebug stream goes to <out.bin>); failures
// report on stderr and exit non-zero so the TS layer never trusts a partial file.
#import "conn.h"

int main(int argc, char **argv){
  if(argc<4){ fprintf(stderr,"usage: capture <udid> <seconds> <out.bin>\n"); return 1; }
  double secs = atof(argv[2]);
  @autoreleasepool{
    loadInstrumentsFrameworks();
    int spid=-1; id conn=connectLocalHub(&spid);
    if(!conn){ fprintf(stderr,"capture: could not connect to DTServiceHub\n"); return 2; }
    ((void(*)(id,SEL))objc_msgSend)(conn, sel_registerName("resume"));
    ((void(*)(id,SEL,id))objc_msgSend)(conn, sel_registerName("_notifyOfPublishedCapabilities:"),
        (@{@"com.apple.private.DTXBlockCompression": @2, @"com.apple.private.DTXConnection": @1}));

    id ch = ((id(*)(id,SEL,id))objc_msgSend)(conn, sel_registerName("makeChannelWithIdentifier:"),
        @"com.apple.instruments.server.services.coreprofilesessiontap");
    if(!ch){ fprintf(stderr,"capture: could not open coreprofilesessiontap channel\n"); return 2; }

    NSString *outPath=[NSString stringWithUTF8String:argv[3]];
    [[NSFileManager defaultManager] createFileAtPath:outPath contents:nil attributes:nil];
    NSFileHandle *fh=[NSFileHandle fileHandleForWritingAtPath:outPath];
    if(!fh){ fprintf(stderr,"capture: cannot open output file %s\n", argv[3]); return 2; }

    __block long long totalBytes=0;
    __block BOOL writeFailed=NO;
    void (^h)(id) = ^(id msg){
      id data=((id(*)(id,SEL))objc_msgSend)(msg, sel_registerName("data"));
      if([data isKindOfClass:[NSData class]] && [data length]>0){
        totalBytes+=[data length];
        uint32_t len=(uint32_t)[data length];
        @try{
          [fh writeData:[NSData dataWithBytes:&len length:4]];
          [fh writeData:data];
        }@catch(id e){
          // disk full / IO error — the stream would silently truncate, so flag it
          // and exit non-zero rather than leave a valid-looking partial file.
          if(!writeFailed) fprintf(stderr,"capture: write failed: %s\n", [[e description]UTF8String]);
          writeFailed=YES;
        }
      }
    };
    ((void(*)(id,SEL,id))objc_msgSend)(ch, sel_registerName("setMessageHandler:"), h);

    NSString *uuid=[[NSUUID UUID] UUIDString];
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

    ((void(*)(id,SEL,id,id))objc_msgSend)(ch, sel_registerName("sendMessage:replyHandler:"),
        DTXMsg1(sel_registerName("setConfig:"), config), (id)nil);
    ((void(*)(id,SEL,id,id))objc_msgSend)(ch, sel_registerName("sendMessage:replyHandler:"),
        DTXMsg0(sel_registerName("start")), (id)nil);

    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:secs]];

    ((void(*)(id,SEL,id,id))objc_msgSend)(ch, sel_registerName("sendMessage:replyHandler:"),
        DTXMsg0(sel_registerName("stop")), (id)nil);
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.3]];
    [fh closeFile];

    if(writeFailed){ fprintf(stderr,"capture: output truncated by write error\n"); return 4; }
    return totalBytes>0 ? 0 : 3;
  }
}
