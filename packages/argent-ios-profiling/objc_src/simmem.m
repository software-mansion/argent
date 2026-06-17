// simmem — per-process MEMORY profiler for the iOS sim over DTX (sysmontap), no xctrace.
// usage: simmem <udid> <seconds> <target-pid>
#import "conn.h"
int main(int argc,char**argv){
  setbuf(stdout,NULL);
  if(argc<4){ printf("usage: simmem <udid> <seconds> <target-pid>\n"); return 1; }
  double secs=atof(argv[2]); int tpid=atoi(argv[3]);
  @autoreleasepool{
    loadInstrumentsFrameworks();
    int spid=-1; id conn=connectLocalHub(&spid);
    if(!conn){printf("no conn\n");return 2;}
    ((void(*)(id,SEL))objc_msgSend)(conn, sel_registerName("resume"));
    ((void(*)(id,SEL,id))objc_msgSend)(conn, sel_registerName("_notifyOfPublishedCapabilities:"),
        (@{@"com.apple.private.DTXBlockCompression": @2, @"com.apple.private.DTXConnection": @1}));
    id ch=((id(*)(id,SEL,id))objc_msgSend)(conn, sel_registerName("makeChannelWithIdentifier:"),
        @"com.apple.instruments.server.services.sysmontap");
    // procAttrs order MUST match how we read the row below
    NSArray *procAttrs=@[@"pid",@"physFootprint",@"memResidentSize",@"cpuUsage"];
    ((void(*)(id,SEL,id))objc_msgSend)(ch, sel_registerName("setMessageHandler:"), ^(id o){
      // sysmontap update payload = OS_dispatch_data wrapping an NSKeyedArchiver
      // graph of plain Foundation containers — decode it with the secure (non
      // deprecated) unarchiver, allowlisting the container + leaf classes.
      id pl=((id(*)(id,SEL))objc_msgSend)(o,sel_registerName("object"));
      NSData *d = [pl isKindOfClass:[NSData class]] ? (NSData*)pl : nil;
      if(!d) return;
      NSSet *allowed=[NSSet setWithObjects:[NSArray class],[NSDictionary class],
          [NSNumber class],[NSString class],[NSData class],[NSDate class],nil];
      id top=nil; @try{
        top=((id(*)(id,SEL,NSSet*,NSData*,NSError**))objc_msgSend)(
            [NSKeyedUnarchiver class],
            sel_registerName("unarchivedObjectOfClasses:fromData:error:"), allowed, d, NULL);
      }@catch(id e){}
      if(!top) return;
      NSArray *arr = [top isKindOfClass:[NSArray class]] ? top : @[top];
      for(id e in arr){
        if(![e isKindOfClass:[NSDictionary class]]) continue;
        NSDictionary *procs=e[@"Processes"];
        if(![procs isKindOfClass:[NSDictionary class]]) continue;
        id row=procs[@(tpid)] ?: procs[[@(tpid) stringValue]];
        if([row isKindOfClass:[NSArray class]] && [row count]>=2){
          // The row values line up with procAttrs, but sysmontap may or may not
          // echo the leading `pid` column. Detect it deterministically: if the
          // first value equals the target pid, footprint/resident start at index 1
          // (footprints are millions of bytes, so they never collide with a pid).
          NSUInteger base=([row[0] longLongValue]==(long long)tpid)?1:0;
          if([row count]>=base+2){
            double fp=[row[base] doubleValue]/1048576.0, rss=[row[base+1] doubleValue]/1048576.0;
            printf("pid %d  physFootprint=%.1f MB  resident=%.1f MB\n", tpid, fp, rss);
          }
        }
      }
    });
    ((void(*)(id,SEL,id,id))objc_msgSend)(ch, sel_registerName("sendMessage:replyHandler:"),
        DTXMsg1(sel_registerName("setConfig:"),
          (@{@"ur":@500,@"bm":@0,@"cpuUsage":@YES,@"sampleInterval":@500000000ULL,
             @"procAttrs":procAttrs,@"sysAttrs":@[@"vmFreeCount"]})), (id)nil);
    ((void(*)(id,SEL,id,id))objc_msgSend)(ch, sel_registerName("sendMessage:replyHandler:"),
        DTXMsg0(sel_registerName("start")), (id)nil);
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:secs]];
    return 0;
  }
}
