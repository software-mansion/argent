#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/// Multi-finger touch synthesis through XCTest's own event classes.
///
/// The public XCUICoordinate API can drive one finger along one straight
/// press-then-drag. Pinches, rotations and any path with waypoints need several
/// fingers moving at once, which XCTest builds internally from
/// XCPointerEventPath and XCSynthesizedEventRecord. Those classes are not in
/// any public header, so they are looked up by name at runtime: nothing links
/// against a private symbol, and an Xcode that renames or drops one makes
/// `unavailabilityReason` answer instead of the runner failing to load.
@interface ArgentTouchSynthesizer : NSObject

/// nil when every class and selector this needs is present, otherwise a
/// sentence naming what is missing.
+ (NSString *_Nullable)unavailabilityReason;

/// The orientation the app's interface is drawn in, which can differ from the
/// way the phone is held (a portrait-only app on a phone turned sideways).
/// UIInterfaceOrientationUnknown when this XCTest cannot say.
+ (UIInterfaceOrientation)interfaceOrientationOfApplication:(id)application;

/// Plays every finger at once as one event record, and returns once the last
/// finger has lifted. Each finger is an array of `[x, y, seconds]` waypoints:
/// points in the panel's own portrait space, and the time since the gesture
/// started. The finger touches down at its first waypoint, moves through the
/// rest in order, and lifts a hair after its last. Waypoint times must not
/// decrease.
///
/// Returns nil on success, otherwise "Name: reason" for the failure or the
/// NSException XCTest threw (Swift cannot catch those).
+ (NSString *_Nullable)synthesizeFingers:
            (NSArray<NSArray<NSArray<NSNumber *> *> *> *)fingers
                      interfaceOrientation:(UIInterfaceOrientation)orientation;

@end

NS_ASSUME_NONNULL_END
