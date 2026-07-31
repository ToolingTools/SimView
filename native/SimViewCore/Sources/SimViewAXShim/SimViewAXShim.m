/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * Portions of the translation flow are adapted from IDB and are licensed under
 * the MIT license. This file has been substantially modified for SimView.
 */

#import "SimViewAXShim.h"

#import <AppKit/AppKit.h>
#import <dlfcn.h>
#import <objc/message.h>

static NSString *const SVAXErrorDomain = @"dev.simview.accessibility";

@interface NSObject (SVSimDeviceAccessibility)
- (void)sendAccessibilityRequestAsync:(id)request
                      completionQueue:(dispatch_queue_t)queue
                    completionHandler:(void (^)(id response))completionHandler;
@end

@interface SVAXTranslationObject : NSObject
@property(nonatomic, copy) NSString *bridgeDelegateToken;
@end

@interface SVAXPlatformElement : NSAccessibilityElement
@property(nonatomic, retain) SVAXTranslationObject *translation;
- (NSRect)accessibilityFrame;
- (NSString *)accessibilityRole;
- (NSString *)accessibilitySubrole;
- (NSString *)accessibilityLabel;
- (NSString *)accessibilityTitle;
- (NSString *)accessibilityHelp;
- (NSString *)accessibilityRoleDescription;
- (NSString *)accessibilityIdentifier;
- (NSString *)accessibilityPlaceholderValue;
- (id)accessibilityValue;
- (NSArray *)accessibilityChildren;
- (NSArray<NSString *> *)accessibilityActionNames;
- (BOOL)isAccessibilityEnabled;
- (BOOL)isAccessibilityHidden;
- (BOOL)isAccessibilityFocused;
- (BOOL)isAccessibilityExpanded;
- (BOOL)isAccessibilityProtectedContent;
@end

@interface SVAXTranslator : NSObject
+ (instancetype)sharedInstance;
@property(nonatomic, weak) id bridgeTokenDelegate;
- (SVAXTranslationObject *)frontmostApplicationWithDisplayId:(unsigned int)displayId
                                         bridgeDelegateToken:(NSString *)token;
- (SVAXTranslationObject *)objectAtPoint:(CGPoint)point
                               displayId:(unsigned int)displayId
                     bridgeDelegateToken:(NSString *)token;
- (SVAXPlatformElement *)macPlatformElementFromTranslation:(SVAXTranslationObject *)translation;
@end

typedef id _Nullable (^SVAXTranslationCallback)(id request);

@interface SVAccessibilityDispatcher : NSObject
@property(nonatomic, strong) NSMapTable<NSString *, NSObject *> *devices;
@property(nonatomic, strong) dispatch_queue_t callbackQueue;
@end

@implementation SVAccessibilityDispatcher

- (instancetype)init {
  self = [super init];
  if (self) {
    _devices = [NSMapTable strongToWeakObjectsMapTable];
    _callbackQueue =
        dispatch_queue_create("dev.simview.accessibility.callback", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (SVAXTranslationCallback)accessibilityTranslationDelegateBridgeCallbackWithToken:
    (NSString *)token {
  __weak typeof(self) weakSelf = self;
  return ^id(id request) {
    typeof(self) self = weakSelf;
    NSObject *device = [self.devices objectForKey:token];
    if (!device) {
      Class responseClass = NSClassFromString(@"AXPTranslatorResponse");
      if (![responseClass respondsToSelector:NSSelectorFromString(@"empty")]) {
        return nil;
      }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
      return [responseClass performSelector:NSSelectorFromString(@"empty")];
#pragma clang diagnostic pop
    }

    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block id response = nil;
    [device sendAccessibilityRequestAsync:request
                          completionQueue:self.callbackQueue
                        completionHandler:^(id innerResponse) {
                          response = innerResponse;
                          dispatch_semaphore_signal(semaphore);
                        }];
    if (dispatch_semaphore_wait(
            semaphore, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC))) != 0) {
      return nil;
    }
    return response;
  };
}

- (CGRect)accessibilityTranslationConvertPlatformFrameToSystem:(CGRect)rect
                                                     withToken:(NSString *)token {
  (void)token;
  return rect;
}

- (id)accessibilityTranslationRootParentWithToken:(NSString *)token {
  (void)token;
  return nil;
}

@end

static SVAccessibilityDispatcher *SVDispatcher(void) {
  static SVAccessibilityDispatcher *dispatcher;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    dispatcher = [SVAccessibilityDispatcher new];
  });
  return dispatcher;
}

static SVAXTranslator *SVTranslator(void) {
  static SVAXTranslator *translator;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    dlopen("/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework/"
           "AccessibilityPlatformTranslation",
           RTLD_NOW | RTLD_GLOBAL);
    Class translatorClass = NSClassFromString(@"AXPTranslator");
    if ([translatorClass respondsToSelector:@selector(sharedInstance)]) {
      translator = [translatorClass sharedInstance];
      translator.bridgeTokenDelegate = SVDispatcher();
    }
  });
  return translator;
}

static NSError *SVError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:SVAXErrorDomain
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey : message}];
}

static id SVJSONValue(id value) {
  if (!value)
    return [NSNull null];
  if ([value isKindOfClass:NSString.class] || [value isKindOfClass:NSNumber.class] ||
      [value isKindOfClass:NSNull.class]) {
    return value;
  }
  return [value description] ?: [NSNull null];
}

static void SVSetIfPresent(NSMutableDictionary *dictionary, NSString *key, id value) {
  if (!value)
    return;
  if ([value isKindOfClass:NSString.class] && [(NSString *)value length] == 0)
    return;
  dictionary[key] = SVJSONValue(value);
}

static NSDictionary *SVFrameDictionary(NSRect frame, NSRect screenFrame) {
  double width = NSWidth(screenFrame);
  double height = NSHeight(screenFrame);
  double nx = width > 0 ? (NSMinX(frame) - NSMinX(screenFrame)) / width : 0;
  double ny = height > 0 ? (NSMinY(frame) - NSMinY(screenFrame)) / height : 0;
  double nw = width > 0 ? NSWidth(frame) / width : 0;
  double nh = height > 0 ? NSHeight(frame) / height : 0;
  return @{
    @"points" : @{
      @"x" : @(NSMinX(frame)),
      @"y" : @(NSMinY(frame)),
      @"width" : @(NSWidth(frame)),
      @"height" : @(NSHeight(frame))
    },
    @"normalized" : @{
      @"x" : @(MAX(0, MIN(1, nx))),
      @"y" : @(MAX(0, MIN(1, ny))),
      @"width" : @(MAX(0, MIN(1, nw))),
      @"height" : @(MAX(0, MIN(1, nh)))
    }
  };
}

static NSDictionary *SVSerializeElement(SVAXPlatformElement *element, NSString *snapshotID,
                                        NSString *bridgeToken, NSRect screenFrame,
                                        NSUInteger *ordinal, NSUInteger maxNodes, NSUInteger depth,
                                        BOOL *truncated) {
  if (*ordinal >= maxNodes || depth > 48) {
    *truncated = YES;
    return @{};
  }
  NSUInteger current = (*ordinal)++;
  NSMutableDictionary *node = [NSMutableDictionary dictionary];
  node[@"ref"] = [NSString stringWithFormat:@"ax:%@:%lu", snapshotID, (unsigned long)current];

  element.translation.bridgeDelegateToken = bridgeToken;
  SVSetIfPresent(node, @"role", [element accessibilityRole]);
  SVSetIfPresent(node, @"subrole", [element accessibilitySubrole]);
  SVSetIfPresent(node, @"label", [element accessibilityLabel]);
  SVSetIfPresent(node, @"title", [element accessibilityTitle]);
  SVSetIfPresent(node, @"help", [element accessibilityHelp]);
  SVSetIfPresent(node, @"roleDescription", [element accessibilityRoleDescription]);
  SVSetIfPresent(node, @"identifier", [element accessibilityIdentifier]);
  SVSetIfPresent(node, @"placeholder", [element accessibilityPlaceholderValue]);

  BOOL protectedContent = [element respondsToSelector:@selector(isAccessibilityProtectedContent)] &&
                          [element isAccessibilityProtectedContent];
  if (!protectedContent)
    SVSetIfPresent(node, @"value", [element accessibilityValue]);
  else
    node[@"valueRedacted"] = @YES;

  BOOL enabled = [element respondsToSelector:@selector(isAccessibilityEnabled)]
                     ? [element isAccessibilityEnabled]
                     : YES;
  node[@"enabled"] = enabled ? @YES : @NO;
  if ([element respondsToSelector:@selector(isAccessibilityHidden)]) {
    node[@"hidden"] = [element isAccessibilityHidden] ? @YES : @NO;
  }
  if ([element respondsToSelector:@selector(isAccessibilityFocused)]) {
    node[@"focused"] = [element isAccessibilityFocused] ? @YES : @NO;
  }
  if ([element respondsToSelector:@selector(isAccessibilityExpanded)]) {
    node[@"expanded"] = [element isAccessibilityExpanded] ? @YES : @NO;
  }
  if ([element respondsToSelector:@selector(accessibilityActionNames)]) {
    NSArray *actions = [element accessibilityActionNames];
    if (actions.count)
      node[@"actions"] = actions;
  }

  NSRect frame = [element accessibilityFrame];
  if (!NSEqualRects(frame, NSZeroRect))
    node[@"frame"] = SVFrameDictionary(frame, screenFrame);

  NSArray *children = [element accessibilityChildren] ?: @[];
  NSMutableArray *serializedChildren = [NSMutableArray arrayWithCapacity:children.count];
  for (id child in children) {
    if (*ordinal >= maxNodes) {
      *truncated = YES;
      break;
    }
    NSDictionary *serialized = SVSerializeElement(child, snapshotID, bridgeToken, screenFrame,
                                                  ordinal, maxNodes, depth + 1, truncated);
    if (serialized.count)
      [serializedChildren addObject:serialized];
  }
  if (serializedChildren.count)
    node[@"children"] = serializedChildren;
  return node;
}

static NSDictionary *SVResolve(NSObject *device, CGPoint *point, NSRect serializationFrame,
                               NSUInteger maxNodes, NSError **error) {
  SVAXTranslator *translator = SVTranslator();
  SEL deviceSelector =
      NSSelectorFromString(@"sendAccessibilityRequestAsync:completionQueue:completionHandler:");
  if (!translator || ![device respondsToSelector:deviceSelector]) {
    if (error)
      *error = SVError(1, @"CoreSimulator accessibility translation is unavailable");
    return nil;
  }

  NSString *token = NSUUID.UUID.UUIDString;
  [SVDispatcher().devices setObject:device forKey:token];
  @try {
    SVAXTranslationObject *translation =
        point ? [translator objectAtPoint:*point displayId:0 bridgeDelegateToken:token]
              : [translator frontmostApplicationWithDisplayId:0 bridgeDelegateToken:token];
    if (!translation) {
      if (error)
        *error = SVError(2, @"The frontmost application returned no accessibility object");
      return nil;
    }
    translation.bridgeDelegateToken = token;
    SVAXPlatformElement *element = [translator macPlatformElementFromTranslation:translation];
    if (!element) {
      if (error)
        *error = SVError(3, @"Accessibility translation produced no platform element");
      return nil;
    }
    element.translation.bridgeDelegateToken = token;

    NSRect screenFrame = serializationFrame;
    if (NSWidth(screenFrame) <= 0 || NSHeight(screenFrame) <= 0) {
      screenFrame = [element accessibilityFrame];
    }
    if (NSWidth(screenFrame) <= 0 || NSHeight(screenFrame) <= 0) {
      NSScreen *screen = NSScreen.mainScreen;
      screenFrame = NSMakeRect(0, 0, NSWidth(screen.frame), NSHeight(screen.frame));
    }
    NSString *snapshotID = NSUUID.UUID.UUIDString;
    NSUInteger ordinal = 0;
    BOOL truncated = NO;
    NSDictionary *root = SVSerializeElement(element, snapshotID, token, screenFrame, &ordinal,
                                            MAX(1, maxNodes), 0, &truncated);
    return @{
      @"schemaVersion" : @1,
      @"snapshotId" : snapshotID,
      @"capturedAt" : [[NSISO8601DateFormatter new] stringFromDate:[NSDate date]],
      @"source" : @"core-simulator-ax",
      @"screen" : @{
        @"x" : @(screenFrame.origin.x),
        @"y" : @(screenFrame.origin.y),
        @"width" : @(screenFrame.size.width),
        @"height" : @(screenFrame.size.height)
      },
      @"root" : root,
      @"stats" : @{@"nodeCount" : @(ordinal), @"truncated" : @(truncated)}
    };
  } @catch (NSException *exception) {
    if (error)
      *error = SVError(4, exception.reason ?: @"Accessibility translation failed");
    return nil;
  } @finally {
    [SVDispatcher().devices removeObjectForKey:token];
  }
}

@implementation SVAccessibilityBridge

+ (BOOL)isAvailable {
  return SVTranslator() != nil;
}

+ (NSDictionary *)snapshotForDevice:(NSObject *)device
                           maxNodes:(NSUInteger)maxNodes
                              error:(NSError **)error {
  return SVResolve(device, NULL, NSZeroRect, maxNodes, error);
}

+ (NSDictionary *)elementForDevice:(NSObject *)device
                                 x:(double)x
                                 y:(double)y
                       screenWidth:(double)screenWidth
                      screenHeight:(double)screenHeight
                             error:(NSError **)error {
  CGPoint point = CGPointMake(x, y);
  return SVResolve(device, &point, NSMakeRect(0, 0, screenWidth, screenHeight), 1, error);
}

@end
