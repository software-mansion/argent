#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runs a block inside an Objective-C @try so the NSExceptions XCTest's
/// accessibility machinery throws (stale elements, AX server errors) surface
/// as a returned description instead of crashing the whole test process;
/// Swift cannot catch them on its own.
@interface ArgentExceptionGuard : NSObject

/// Returns nil when the block completed, otherwise "Name: reason".
+ (NSString *_Nullable)runCatching:(NS_NOESCAPE dispatch_block_t)block;

@end

NS_ASSUME_NONNULL_END
