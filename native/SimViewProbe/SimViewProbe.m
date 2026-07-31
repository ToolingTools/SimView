#import <UIKit/UIKit.h>
#import <Foundation/Foundation.h>
#import <arpa/inet.h>
#import <sys/socket.h>
#import <unistd.h>

static int SVProbeSocket = -1;

static NSString *SVClassName(id object) {
  return object ? NSStringFromClass([object class]) : nil;
}

static NSDictionary *SVRect(CGRect rect, CGRect screen) {
  return @{
    @"x" : @(rect.origin.x / MAX(1, screen.size.width)),
    @"y" : @(rect.origin.y / MAX(1, screen.size.height)),
    @"width" : @(rect.size.width / MAX(1, screen.size.width)),
    @"height" : @(rect.size.height / MAX(1, screen.size.height)),
  };
}

static NSString *SVActivationState(UISceneActivationState state) {
  switch (state) {
  case UISceneActivationStateForegroundActive:
    return @"foregroundActive";
  case UISceneActivationStateForegroundInactive:
    return @"foregroundInactive";
  case UISceneActivationStateBackground:
    return @"background";
  default:
    return @"unattached";
  }
}

static NSDictionary *SVController(UIViewController *controller, NSString *relationship,
                                  BOOL visible, NSHashTable *seen) {
  if (!controller || [seen containsObject:controller])
    return @{};
  [seen addObject:controller];
  NSMutableDictionary *value = [@{
    @"className" : SVClassName(controller),
    @"relationship" : relationship,
    @"visible" : @(visible),
  } mutableCopy];
  if (controller.title.length)
    value[@"title"] = controller.title;
  if (controller.restorationIdentifier.length) {
    value[@"restorationIdentifier"] = controller.restorationIdentifier;
  }

  NSMutableArray *children = [NSMutableArray array];
  if (controller.presentedViewController) {
    NSDictionary *presented =
        SVController(controller.presentedViewController, @"presented", YES, seen);
    if (presented.count)
      [children addObject:presented];
  }
  if ([controller isKindOfClass:UINavigationController.class]) {
    UINavigationController *navigation = (UINavigationController *)controller;
    for (UIViewController *child in navigation.viewControllers) {
      NSDictionary *item = SVController(
          child,
          child == navigation.visibleViewController ? @"navigation-visible" : @"navigation-stack",
          child == navigation.visibleViewController, seen);
      if (item.count)
        [children addObject:item];
    }
  } else if ([controller isKindOfClass:UITabBarController.class]) {
    UITabBarController *tabs = (UITabBarController *)controller;
    for (UIViewController *child in tabs.viewControllers) {
      NSDictionary *item =
          SVController(child, child == tabs.selectedViewController ? @"tab-selected" : @"tab-child",
                       child == tabs.selectedViewController, seen);
      if (item.count)
        [children addObject:item];
    }
  } else if ([controller isKindOfClass:UISplitViewController.class]) {
    for (UIViewController *child in ((UISplitViewController *)controller).viewControllers) {
      NSDictionary *item = SVController(child, @"split-child", child.view.window != nil, seen);
      if (item.count)
        [children addObject:item];
    }
  } else {
    for (UIViewController *child in controller.childViewControllers) {
      NSDictionary *item = SVController(child, @"child", child.view.window != nil, seen);
      if (item.count)
        [children addObject:item];
    }
  }
  if (children.count)
    value[@"children"] = children;
  return value;
}

static NSArray *SVVisibleControllerPath(UIViewController *controller) {
  NSMutableArray *path = [NSMutableArray array];
  UIViewController *current = controller;
  NSHashTable *seen = [NSHashTable weakObjectsHashTable];
  while (current && ![seen containsObject:current]) {
    [seen addObject:current];
    [path addObject:SVClassName(current)];
    if (current.presentedViewController)
      current = current.presentedViewController;
    else if ([current isKindOfClass:UINavigationController.class]) {
      current = ((UINavigationController *)current).visibleViewController;
    } else if ([current isKindOfClass:UITabBarController.class]) {
      current = ((UITabBarController *)current).selectedViewController;
    } else if ([current isKindOfClass:UISplitViewController.class]) {
      current = ((UISplitViewController *)current).viewControllers.lastObject;
    } else {
      current = current.childViewControllers.lastObject;
    }
  }
  return path;
}

static NSArray *SVSceneContext(void) {
  NSMutableArray *scenes = [NSMutableArray array];
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:UIWindowScene.class])
      continue;
    UIWindowScene *windowScene = (UIWindowScene *)scene;
    NSMutableArray *windows = [NSMutableArray array];
    for (UIWindow *window in windowScene.windows) {
      NSMutableDictionary *item = [@{
        @"className" : SVClassName(window),
        @"key" : @(window.isKeyWindow),
        @"hidden" : @(window.hidden),
        @"alpha" : @(window.alpha),
        @"level" : @(window.windowLevel),
        @"frame" : SVRect(window.frame, windowScene.screen.bounds),
      } mutableCopy];
      if (window.rootViewController) {
        item[@"controllerTree"] =
            SVController(window.rootViewController, @"root", window.isKeyWindow,
                         [NSHashTable weakObjectsHashTable]);
        item[@"visibleControllerPath"] = SVVisibleControllerPath(window.rootViewController);
      }
      [windows addObject:item];
    }
    NSMutableDictionary *item = [@{
      @"persistentIdentifier" : windowScene.session.persistentIdentifier ?: @"",
      @"role" : windowScene.session.role ?: @"",
      @"activationState" : SVActivationState(windowScene.activationState),
      @"windows" : windows,
    } mutableCopy];
    if (windowScene.session.configuration.name.length) {
      item[@"configurationName"] = windowScene.session.configuration.name;
    }
    if (windowScene.delegate)
      item[@"delegateClass"] = SVClassName(windowScene.delegate);
    [scenes addObject:item];
  }
  return scenes;
}

static UIWindow *SVTargetWindow(CGPoint point) {
  NSArray *scenes = [UIApplication.sharedApplication.connectedScenes.allObjects
      sortedArrayUsingComparator:^NSComparisonResult(UIScene *a, UIScene *b) {
        return a.activationState < b.activationState ? NSOrderedAscending : NSOrderedDescending;
      }];
  for (UIScene *scene in scenes) {
    if (![scene isKindOfClass:UIWindowScene.class])
      continue;
    NSArray *windows = [((UIWindowScene *)scene).windows
        sortedArrayUsingComparator:^NSComparisonResult(UIWindow *a, UIWindow *b) {
          if (a.isKeyWindow != b.isKeyWindow)
            return a.isKeyWindow ? NSOrderedAscending : NSOrderedDescending;
          return a.windowLevel > b.windowLevel ? NSOrderedAscending : NSOrderedDescending;
        }];
    for (UIWindow *window in windows) {
      if (!window.hidden && window.alpha > 0.01 && CGRectContainsPoint(window.frame, point)) {
        return window;
      }
    }
  }
  return nil;
}

static NSDictionary *SVInspectPoint(double x, double y) {
  CGRect screen = UIScreen.mainScreen.bounds;
  CGPoint screenPoint = CGPointMake(x * screen.size.width, y * screen.size.height);
  UIWindow *window = SVTargetWindow(screenPoint);
  if (!window)
    return @{@"error" : @"No visible window contains the point"};
  CGPoint point = [window convertPoint:screenPoint fromWindow:nil];
  UIView *view = [window hitTest:point withEvent:nil];
  NSMutableDictionary *result = [@{
    @"schemaVersion" : @1,
    @"viewClass" : SVClassName(view) ?: @"",
    @"windowClass" : SVClassName(window),
    @"frame" : view ? SVRect([view convertRect:view.bounds toView:nil], screen) : @{},
    @"userInteractionEnabled" : @(view.userInteractionEnabled),
    @"hidden" : @(view.hidden),
    @"alpha" : @(view.alpha),
  } mutableCopy];
  if (view.accessibilityIdentifier.length)
    result[@"identifier"] = view.accessibilityIdentifier;
  if (view.accessibilityLabel.length)
    result[@"label"] = view.accessibilityLabel;
  UIResponder *responder = view;
  while (responder && ![responder isKindOfClass:UIViewController.class]) {
    responder = responder.nextResponder;
  }
  if ([responder isKindOfClass:UIViewController.class]) {
    result[@"controllerClass"] = SVClassName(responder);
  }
  UIWindowScene *scene = window.windowScene;
  if (scene) {
    result[@"sceneIdentifier"] = scene.session.persistentIdentifier ?: @"";
    result[@"sceneActivationState"] = SVActivationState(scene.activationState);
  }
  result[@"controllerPath"] = SVVisibleControllerPath(window.rootViewController);
  return result;
}

static NSDictionary *SVViewDescription(UIView *view, CGRect screen, NSUInteger depth,
                                       NSUInteger maxDepth, NSUInteger *count, NSUInteger maxNodes,
                                       BOOL includeChildren) {
  if (!view || *count >= maxNodes)
    return @{};
  (*count)++;
  CGRect frame = [view convertRect:view.bounds toView:nil];
  NSMutableDictionary *result = [@{
    @"ref" : [NSString stringWithFormat:@"view-%p", view],
    @"className" : SVClassName(view) ?: @"",
    @"frame" : SVRect(frame, screen),
    @"hidden" : @(view.hidden),
    @"alpha" : @(view.alpha),
    @"userInteractionEnabled" : @(view.userInteractionEnabled),
    @"accessibilityElement" : @(view.isAccessibilityElement),
    @"tag" : @(view.tag),
  } mutableCopy];
  if (view.accessibilityIdentifier.length)
    result[@"identifier"] = view.accessibilityIdentifier;
  if (view.accessibilityLabel.length)
    result[@"label"] = view.accessibilityLabel;
  if (view.accessibilityValue.length)
    result[@"value"] = view.accessibilityValue;
  if (includeChildren && depth < maxDepth && *count < maxNodes) {
    NSMutableArray *children = [NSMutableArray array];
    for (UIView *child in view.subviews) {
      NSDictionary *item =
          SVViewDescription(child, screen, depth + 1, maxDepth, count, maxNodes, YES);
      if (item.count)
        [children addObject:item];
      if (*count >= maxNodes)
        break;
    }
    if (children.count)
      result[@"children"] = children;
  }
  return result;
}

static BOOL SVViewMatches(UIView *view, NSDictionary *filters, CGRect screen) {
  NSString *className = SVClassName(view) ?: @"";
  NSString *exactClass = filters[@"className"];
  NSString *classPrefix = filters[@"classPrefix"];
  if (exactClass.length && ![className isEqualToString:exactClass])
    return NO;
  if (classPrefix.length && ![className hasPrefix:classPrefix])
    return NO;
  NSString *identifier = filters[@"identifier"];
  if (identifier.length && ![view.accessibilityIdentifier isEqualToString:identifier])
    return NO;
  NSString *label = filters[@"label"];
  if (label.length && ![view.accessibilityLabel isEqualToString:label])
    return NO;
  if (filters[@"tag"] && view.tag != [filters[@"tag"] integerValue])
    return NO;
  if ([filters[@"visibleOnly"] boolValue] && (view.hidden || view.alpha <= 0.01 || !view.window))
    return NO;
  if ([filters[@"interactableOnly"] boolValue] &&
      (view.hidden || view.alpha <= 0.01 || !view.userInteractionEnabled || !view.window))
    return NO;
  NSDictionary *point = filters[@"point"];
  if ([point isKindOfClass:NSDictionary.class]) {
    CGPoint screenPoint = CGPointMake([point[@"x"] doubleValue] * screen.size.width,
                                      [point[@"y"] doubleValue] * screen.size.height);
    if (!CGRectContainsPoint([view convertRect:view.bounds toView:nil], screenPoint))
      return NO;
  }
  return YES;
}

static void SVCollectViews(UIView *view, NSDictionary *filters, CGRect screen, NSUInteger depth,
                           NSUInteger maxDepth, NSUInteger *visited, NSUInteger maxNodes,
                           NSMutableArray *matches) {
  if (!view || *visited >= maxNodes || depth > maxDepth)
    return;
  (*visited)++;
  if (SVViewMatches(view, filters, screen)) {
    NSUInteger one = 0;
    [matches addObject:SVViewDescription(view, screen, 0, 0, &one, 1, NO)];
  }
  for (UIView *child in view.subviews) {
    SVCollectViews(child, filters, screen, depth + 1, maxDepth, visited, maxNodes, matches);
    if (*visited >= maxNodes)
      break;
  }
}

static NSArray<UIWindow *> *SVAllWindows(void) {
  NSMutableArray *windows = [NSMutableArray array];
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if ([scene isKindOfClass:UIWindowScene.class]) {
      [windows addObjectsFromArray:((UIWindowScene *)scene).windows];
    }
  }
  return windows;
}

static NSDictionary *SVFindViews(NSDictionary *params) {
  CGRect screen = UIScreen.mainScreen.bounds;
  NSDictionary *filters =
      [params[@"filters"] isKindOfClass:NSDictionary.class] ? params[@"filters"] : params;
  NSUInteger maxDepth = MIN(MAX(1, [params[@"maxDepth"] unsignedIntegerValue] ?: 40), 100);
  NSUInteger maxNodes = MIN(MAX(1, [params[@"maxNodes"] unsignedIntegerValue] ?: 2000), 5000);
  NSUInteger visited = 0;
  NSMutableArray *matches = [NSMutableArray array];
  for (UIWindow *window in SVAllWindows()) {
    SVCollectViews(window, filters, screen, 0, maxDepth, &visited, maxNodes, matches);
    if (visited >= maxNodes)
      break;
  }
  return @{
    @"schemaVersion" : @1,
    @"matches" : matches,
    @"count" : @(matches.count),
    @"visited" : @(visited),
    @"truncated" : @((BOOL)(visited >= maxNodes)),
  };
}

static NSDictionary *SVFullHierarchy(NSDictionary *params) {
  CGRect screen = UIScreen.mainScreen.bounds;
  NSUInteger maxDepth = MIN(MAX(1, [params[@"maxDepth"] unsignedIntegerValue] ?: 12), 40);
  NSUInteger maxNodes = MIN(MAX(1, [params[@"maxNodes"] unsignedIntegerValue] ?: 1200), 5000);
  NSUInteger count = 0;
  NSMutableArray *roots = [NSMutableArray array];
  for (UIWindow *window in SVAllWindows()) {
    NSDictionary *root = SVViewDescription(window, screen, 0, maxDepth, &count, maxNodes, YES);
    if (root.count)
      [roots addObject:root];
    if (count >= maxNodes)
      break;
  }
  return @{
    @"schemaVersion" : @1,
    @"roots" : roots,
    @"nodeCount" : @(count),
    @"maxDepth" : @(maxDepth),
    @"truncated" : @((BOOL)(count >= maxNodes)),
  };
}

static NSDictionary *SVHandleRequest(NSDictionary *request) {
  NSString *method = request[@"method"];
  NSDictionary *params = request[@"params"] ?: @{};
  if ([method isEqualToString:@"context"]) {
    return @{@"schemaVersion" : @1, @"scenes" : SVSceneContext()};
  }
  if ([method isEqualToString:@"inspectPoint"]) {
    return SVInspectPoint([params[@"x"] doubleValue], [params[@"y"] doubleValue]);
  }
  if ([method isEqualToString:@"findViews"]) {
    return SVFindViews(params);
  }
  if ([method isEqualToString:@"fullHierarchy"]) {
    return SVFullHierarchy(params);
  }
  return @{@"error" : [NSString stringWithFormat:@"Unknown probe method %@", method ?: @""]};
}

static BOOL SVWriteLine(int socketFD, NSDictionary *object) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  NSMutableData *line = [json mutableCopy];
  [line appendBytes:"\n" length:1];
  return send(socketFD, line.bytes, line.length, 0) == (ssize_t)line.length;
}

static void SVRunProbe(void) {
  NSDictionary *environment = NSProcessInfo.processInfo.environment;
  int port = [environment[@"SIMVIEW_PROBE_PORT"] intValue];
  NSString *token = environment[@"SIMVIEW_PROBE_TOKEN"];
  if (port <= 0 || token.length < 16)
    return;

  int fd = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in address = {0};
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
    close(fd);
    return;
  }
  SVProbeSocket = fd;
  if (!SVWriteLine(fd, @{@"token" : token, @"pid" : @(getpid()), @"protocolVersion" : @1})) {
    close(fd);
    return;
  }

  NSMutableData *buffer = [NSMutableData data];
  uint8_t bytes[4096];
  while (true) {
    ssize_t count = recv(fd, bytes, sizeof(bytes), 0);
    if (count <= 0)
      break;
    [buffer appendBytes:bytes length:(NSUInteger)count];
    while (true) {
      const void *newline = memchr(buffer.bytes, '\n', buffer.length);
      if (!newline)
        break;
      NSUInteger length = (const uint8_t *)newline - (const uint8_t *)buffer.bytes;
      NSData *line = [buffer subdataWithRange:NSMakeRange(0, length)];
      [buffer replaceBytesInRange:NSMakeRange(0, length + 1) withBytes:NULL length:0];
      NSDictionary *request = [NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
      if (![request isKindOfClass:NSDictionary.class])
        continue;
      __block NSDictionary *result;
      dispatch_sync(dispatch_get_main_queue(), ^{
        result = SVHandleRequest(request);
      });
      SVWriteLine(fd, @{@"id" : request[@"id"] ?: @"", @"result" : result ?: @{}});
    }
  }
  close(fd);
  SVProbeSocket = -1;
}

__attribute__((constructor)) static void SVProbeBootstrap(void) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    SVRunProbe();
  });
}
