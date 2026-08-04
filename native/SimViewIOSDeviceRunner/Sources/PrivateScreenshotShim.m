#import "PrivateScreenshotShim.h"

#import <objc/message.h>
#import <objc/runtime.h>

static NSString *const SVPrivateScreenshotEnvironmentKey = @"SIMVIEW_ENABLE_PRIVATE_SCREENSHOT";
static NSString *const SVPrivateActiveApplicationEnvironmentKey =
    @"SIMVIEW_ENABLE_PRIVATE_ACTIVE_APP";

static BOOL SVPrivateScreenshotEnabled(void) {
  NSString *value = NSProcessInfo.processInfo.environment[SVPrivateScreenshotEnvironmentKey];
  return [value isEqualToString:@"1"];
}

static SEL SVScreenshotSelector(id provider) {
  NSArray<NSString *> *names =
      @[ @"_XCT_requestScreenshotWithReply:", @"_XCT_requestScreenshot:withReply:" ];
  for (NSString *name in names) {
    SEL selector = NSSelectorFromString(name);
    if ([provider respondsToSelector:selector]) {
      return selector;
    }
  }
  return NULL;
}

BOOL SVPrivateScreenshotAvailable(id provider) {
  return SVPrivateScreenshotEnabled() && SVScreenshotSelector(provider) != NULL;
}

NSData *_Nullable SVPrivateScreenshotPNG(id provider, NSTimeInterval timeout, NSError **error) {
  if (!SVPrivateScreenshotEnabled()) {
    if (error != NULL) {
      *error = [NSError
          errorWithDomain:@"tools.simview.ios-runner"
                     code:1
                 userInfo:@{
                   NSLocalizedDescriptionKey : @"Private screenshot compatibility is disabled"
                 }];
    }
    return nil;
  }

  SEL selector = SVScreenshotSelector(provider);
  if (selector == NULL) {
    if (error != NULL) {
      *error = [NSError
          errorWithDomain:@"tools.simview.ios-runner"
                     code:2
                 userInfo:@{
                   NSLocalizedDescriptionKey :
                       @"This XCTest build does not expose a compatible screenshot selector"
                 }];
    }
    return nil;
  }

  __block NSData *result = nil;
  __block NSError *requestError = nil;
  __block BOOL finished = NO;
  void (^reply)(id, NSError *) = ^(id screenshot, NSError *replyError) {
    requestError = replyError;
    if ([screenshot respondsToSelector:NSSelectorFromString(@"PNGRepresentation")]) {
      result = [screenshot valueForKey:@"PNGRepresentation"];
    } else if ([screenshot isKindOfClass:NSData.class]) {
      result = screenshot;
    }
    finished = YES;
  };

  @try {
    if ([NSStringFromSelector(selector) isEqualToString:@"_XCT_requestScreenshotWithReply:"]) {
      ((void (*)(id, SEL, id))objc_msgSend)(provider, selector, reply);
    } else {
      NSDictionary *request = @{@"uti" : @"public.png", @"compressionQuality" : @1.0};
      ((void (*)(id, SEL, id, id))objc_msgSend)(provider, selector, request, reply);
    }
  } @catch (NSException *exception) {
    requestError = [NSError errorWithDomain:@"tools.simview.ios-runner"
                                       code:3
                                   userInfo:@{
                                     NSLocalizedDescriptionKey : exception.reason
                                         ?: @"Private screenshot request failed"
                                   }];
    finished = YES;
  }

  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:MAX(0.05, timeout)];
  while (!finished && deadline.timeIntervalSinceNow > 0) {
    [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode
                           beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.005]];
  }
  if (!finished && requestError == nil) {
    requestError = [NSError
        errorWithDomain:@"tools.simview.ios-runner"
                   code:4
               userInfo:@{NSLocalizedDescriptionKey : @"Private screenshot request timed out"}];
  }
  if (error != NULL) {
    *error = requestError;
  }
  return result;
}

NSString *_Nullable SVPrivateActiveApplicationBundleIdentifier(void) {
  NSString *enabled =
      NSProcessInfo.processInfo.environment[SVPrivateActiveApplicationEnvironmentKey];
  if (![enabled isEqualToString:@"1"]) {
    return nil;
  }
  Class applicationClass = NSClassFromString(@"XCUIApplication");
  if (applicationClass == Nil) {
    return nil;
  }
  id application = nil;
  for (NSString *name in @[ @"activeApplication", @"_activeApplication" ]) {
    SEL selector = NSSelectorFromString(name);
    if ([applicationClass respondsToSelector:selector]) {
      @try {
        application = ((id (*)(id, SEL))objc_msgSend)(applicationClass, selector);
      } @catch (__unused NSException *exception) {
        application = nil;
      }
      if (application != nil) {
        break;
      }
    }
  }
  for (NSString *name in @[ @"bundleIdentifier", @"bundleID" ]) {
    SEL selector = NSSelectorFromString(name);
    if ([application respondsToSelector:selector]) {
      @try {
        id value = ((id (*)(id, SEL))objc_msgSend)(application, selector);
        if ([value isKindOfClass:NSString.class] && [value length] > 0) {
          return value;
        }
      } @catch (__unused NSException *exception) {
      }
    }
  }
  return nil;
}
