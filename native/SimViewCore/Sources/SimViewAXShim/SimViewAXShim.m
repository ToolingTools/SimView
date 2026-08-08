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
#import <objc/runtime.h>

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
@property(nonatomic, copy) id appNotificationTestingCallback;
- (void)enableAccessibility;
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
@property(nonatomic, strong) NSMapTable<NSObject *, NSString *> *tokens;
@property(nonatomic, strong) NSMutableDictionary<NSString *, dispatch_block_t> *handlers;
@property(nonatomic, strong) dispatch_queue_t callbackQueue;
- (NSString *)tokenForDevice:(NSObject *)device;
- (void)observeDevice:(NSObject *)device handler:(dispatch_block_t)handler;
- (void)stopObservingDevice:(NSObject *)device;
- (void)dispatchNotification:(unsigned long long)notification
                        data:(id)data
            associatedObject:(id)associatedObject;
@end

@implementation SVAccessibilityDispatcher

- (instancetype)init {
  self = [super init];
  if (self) {
    _devices = [NSMapTable strongToWeakObjectsMapTable];
    _tokens = [NSMapTable strongToStrongObjectsMapTable];
    _handlers = [NSMutableDictionary dictionary];
    _callbackQueue =
        dispatch_queue_create("dev.simview.accessibility.callback", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (NSString *)tokenForDevice:(NSObject *)device {
  @synchronized(self) {
    NSString *token = [_tokens objectForKey:device];
    if (!token) {
      token = NSUUID.UUID.UUIDString;
      [_tokens setObject:token forKey:device];
    }
    [_devices setObject:device forKey:token];
    return token;
  }
}

- (void)observeDevice:(NSObject *)device handler:(dispatch_block_t)handler {
  NSString *token = [self tokenForDevice:device];
  @synchronized(self) {
    _handlers[token] = [handler copy];
  }
}

- (void)stopObservingDevice:(NSObject *)device {
  @synchronized(self) {
    NSString *token = [_tokens objectForKey:device];
    if (token)
      [_handlers removeObjectForKey:token];
  }
}

- (void)dispatchNotification:(unsigned long long)notification
                        data:(id)data
            associatedObject:(id)associatedObject {
  (void) notification;
  (void) data;
  NSString *token = nil;
  @try {
    if ([associatedObject respondsToSelector:NSSelectorFromString(@"bridgeDelegateToken")]) {
      token = [associatedObject valueForKey:@"bridgeDelegateToken"];
    }
  } @catch (__unused NSException *exception) {
    token = nil;
  }
  dispatch_block_t handler = nil;
  @synchronized(self) {
    if (token.length == 0 && _handlers.count == 1)
      token = _handlers.allKeys.firstObject;
    handler = [_handlers[token] copy];
  }
  if (handler)
    dispatch_async(_callbackQueue, handler);
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
            semaphore, dispatch_time(DISPATCH_TIME_NOW, (int64_t) (5 * NSEC_PER_SEC))) != 0) {
      return nil;
    }
    return response;
  };
}

- (CGRect)accessibilityTranslationConvertPlatformFrameToSystem:(CGRect)rect
                                                     withToken:(NSString *)token {
  (void) token;
  return rect;
}

- (id)accessibilityTranslationRootParentWithToken:(NSString *)token {
  (void) token;
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

static IMP SVOriginalHandleNotification;
static void SVSwizzledHandleNotification(id object, SEL selector, unsigned long long notification,
                                         id data, id associatedObject);

static SVAXTranslator *SVTranslator(void) {
  static SVAXTranslator *translator;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    dlopen("/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework/"
           "AccessibilityPlatformTranslation",
           RTLD_NOW | RTLD_GLOBAL);
    Class translatorClass = NSClassFromString(@"AXPTranslator");
    if ([translatorClass respondsToSelector:NSSelectorFromString(@"sharedmacOSInstance")]) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
      translator = [translatorClass performSelector:NSSelectorFromString(@"sharedmacOSInstance")];
#pragma clang diagnostic pop
    } else if ([translatorClass respondsToSelector:@selector(sharedInstance)]) {
      translator = [translatorClass sharedInstance];
    }
    if (translator) {
      translator.bridgeTokenDelegate = SVDispatcher();
      if ([translator respondsToSelector:@selector(enableAccessibility)]) {
        [translator enableAccessibility];
      }
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
  if ([value isKindOfClass:NSString.class] && [(NSString *) value length] == 0)
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
  node[@"ref"] = [NSString stringWithFormat:@"ax:%@:%lu", snapshotID, (unsigned long) current];

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

  NSString *token = [SVDispatcher() tokenForDevice:device];
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

+ (BOOL)startObservingDevice:(NSObject *)device
                     handler:(dispatch_block_t)handler
                       error:(NSError **)error {
  SVAXTranslator *translator = SVTranslator();
  if (!translator || !handler) {
    if (error)
      *error = SVError(5, @"CoreSimulator accessibility observation is unavailable");
    return NO;
  }
  SVAccessibilityDispatcher *dispatcher = SVDispatcher();
  [dispatcher observeDevice:device handler:handler];

  SEL getter = NSSelectorFromString(@"appNotificationTestingCallback");
  SEL setter = NSSelectorFromString(@"setAppNotificationTestingCallback:");
  if ([translator respondsToSelector:getter] && [translator respondsToSelector:setter]) {
    typedef id (*SVGetCallback)(id, SEL);
    SVGetCallback getCallback = (SVGetCallback) objc_msgSend;
    id previous = getCallback(translator, getter);
    id callback = ^(unsigned long long notification, id data, id associatedObject) {
      if (previous) {
        ((void (^)(unsigned long long, id, id)) previous)(notification, data, associatedObject);
      }
      [dispatcher dispatchNotification:notification data:data associatedObject:associatedObject];
    };
    ((void (*)(id, SEL, id)) objc_msgSend)(translator, setter, callback);
    return YES;
  }

  Class translatorClass = object_getClass(translator);
  SEL notificationSelector = NSSelectorFromString(@"handleNotification:data:associatedObject:");
  Method method = class_getInstanceMethod(translatorClass, notificationSelector);
  if (!method) {
    [dispatcher stopObservingDevice:device];
    if (error)
      *error = SVError(6, @"CoreSimulator accessibility notification ABI is unavailable");
    return NO;
  }
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    SVOriginalHandleNotification = method_getImplementation(method);
    method_setImplementation(method, (IMP) SVSwizzledHandleNotification);
  });
  return SVOriginalHandleNotification != NULL;
}

+ (void)stopObservingDevice:(NSObject *)device {
  [SVDispatcher() stopObservingDevice:device];
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

static void SVSwizzledHandleNotification(id object, SEL selector, unsigned long long notification,
                                         id data, id associatedObject) {
  [SVDispatcher() dispatchNotification:notification data:data associatedObject:associatedObject];
  if (SVOriginalHandleNotification) {
    ((void (*)(id, SEL, unsigned long long, id, id)) SVOriginalHandleNotification)(
        object, selector, notification, data, associatedObject);
  }
}
