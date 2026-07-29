/*
 * SimView host accessibility shim.
 *
 * The CoreSimulator/AccessibilityPlatformTranslation interaction follows the
 * MIT-licensed IDB implementation by Meta Platforms, Inc. SimView exposes only
 * immutable JSON-compatible snapshots across this boundary.
 */

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface SVAccessibilityBridge : NSObject

+ (BOOL)isAvailable;

+ (nullable NSDictionary<NSString *, id> *)snapshotForDevice:(NSObject *)device
                                                    maxNodes:(NSUInteger)maxNodes
                                                       error:(NSError **)error;

+ (nullable NSDictionary<NSString *, id> *)elementForDevice:(NSObject *)device
                                                          x:(double)x
                                                          y:(double)y
                                                screenWidth:(double)screenWidth
                                               screenHeight:(double)screenHeight
                                                      error:(NSError **)error;

@end

NS_ASSUME_NONNULL_END
