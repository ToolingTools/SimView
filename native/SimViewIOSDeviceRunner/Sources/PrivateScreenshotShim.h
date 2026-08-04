#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Returns YES only when the compatibility path is explicitly enabled and the
/// provider advertises the selector used by the current Xcode generation.
FOUNDATION_EXPORT BOOL SVPrivateScreenshotAvailable(id provider);

/// Attempts the private XCTest screenshot request and returns PNG data. This
/// seam is optional: callers must always fall back to public XCUIScreenshot.
FOUNDATION_EXPORT NSData *_Nullable SVPrivateScreenshotPNG(id provider, NSTimeInterval timeout,
                                                           NSError **error);

/// Returns the active application's bundle identifier when the current XCTest
/// runtime exposes a compatible class selector. Callers must retain an explicit
/// bundle-identifier fallback.
FOUNDATION_EXPORT NSString *_Nullable SVPrivateActiveApplicationBundleIdentifier(void);

NS_ASSUME_NONNULL_END
