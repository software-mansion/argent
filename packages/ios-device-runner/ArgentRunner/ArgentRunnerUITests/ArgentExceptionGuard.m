#import "ArgentExceptionGuard.h"

@implementation ArgentExceptionGuard

+ (NSString *_Nullable)runCatching:(NS_NOESCAPE dispatch_block_t)block {
  @try {
    block();
    return nil;
  } @catch (NSException *exception) {
    NSString *name = exception.name ?: @"NSException";
    NSString *reason = exception.reason ?: @"unhandled Objective-C exception";
    return [NSString stringWithFormat:@"%@: %@", name, reason];
  }
}

@end
