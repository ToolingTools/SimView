package dev.simview.agent;

import android.os.SystemClock;
import android.os.Build;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;
import java.lang.reflect.Method;

final class InputDispatcher {
  private final Object inputManager;
  private final Method injectInputEvent;
  private final Method setDisplayId;
  private final Method getAssociatedDisplayId;
  private int touchscreenDeviceId = -1;
  private long downTime;
  private boolean touchActive;
  private float lastTouchX;
  private float lastTouchY;

  InputDispatcher() {
    Object manager = null;
    Method injection = null;
    ReflectiveOperationException failure = null;
    for (String className : new String[] {"android.hardware.input.InputManagerGlobal",
                                          "android.hardware.input.InputManager"}) {
      try {
        Class<?> type = Class.forName(className);
        Method instance = type.getDeclaredMethod("getInstance");
        instance.setAccessible(true);
        manager = instance.invoke(null);
        injection = type.getDeclaredMethod("injectInputEvent", InputEvent.class, int.class);
        injection.setAccessible(true);
        break;
      } catch (ReflectiveOperationException error) {
        failure = error;
      }
    }
    if (manager == null || injection == null)
      throw new IllegalStateException("Android input injection is unavailable", failure);
    inputManager = manager;
    injectInputEvent = injection;
    Method displaySetter = null;
    try {
      displaySetter = InputEvent.class.getDeclaredMethod("setDisplayId", int.class);
      displaySetter.setAccessible(true);
    } catch (ReflectiveOperationException ignored) {
      // API 26-28 route events to the default display without this method.
    }
    setDisplayId = displaySetter;
    Method displayGetter = null;
    try {
      displayGetter = InputDevice.class.getDeclaredMethod("getAssociatedDisplayId");
      displayGetter.setAccessible(true);
    } catch (ReflectiveOperationException ignored) {
      // The association was not exposed on older Android releases.
    }
    getAssociatedDisplayId = displayGetter;
  }

  void touch(int phase, float x, float y) throws Exception {
    int action;
    if (phase == 0) {
      cancelActiveTouch();
      action = MotionEvent.ACTION_DOWN;
      downTime = SystemClock.uptimeMillis();
    } else if (phase == 1) {
      action = MotionEvent.ACTION_MOVE;
    } else if (phase == 2) {
      action = MotionEvent.ACTION_UP;
    } else {
      action = MotionEvent.ACTION_CANCEL;
    }
    long now = SystemClock.uptimeMillis();
    MotionEvent.PointerProperties properties = new MotionEvent.PointerProperties();
    properties.id = 0;
    properties.toolType = MotionEvent.TOOL_TYPE_FINGER;
    MotionEvent.PointerCoords coordinates = new MotionEvent.PointerCoords();
    coordinates.x = x;
    coordinates.y = y;
    coordinates.pressure =
        action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL ? 0 : 1;
    coordinates.size = 1;
    MotionEvent event;
    if (Build.VERSION.SDK_INT >= 29) {
      event = MotionEvent.obtain(downTime, now, action, 1,
                                 new MotionEvent.PointerProperties[] {properties},
                                 new MotionEvent.PointerCoords[] {coordinates}, 0, 0, 1, 1,
                                 touchscreenDeviceId(), 0, InputDevice.SOURCE_TOUCHSCREEN, 0, 0, 0);
    } else {
      event = MotionEvent.obtain(downTime, now, action, 1,
                                 new MotionEvent.PointerProperties[] {properties},
                                 new MotionEvent.PointerCoords[] {coordinates}, 0, 0, 1, 1,
                                 touchscreenDeviceId(), 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
    }
    try {
      inject(event);
      lastTouchX = x;
      lastTouchY = y;
      touchActive = action != MotionEvent.ACTION_UP && action != MotionEvent.ACTION_CANCEL;
    } finally {
      event.recycle();
    }
  }

  void cancelActiveTouch() throws Exception {
    if (touchActive)
      touch(3, lastTouchX, lastTouchY);
  }

  void tap(float x, float y, int durationMs) throws Exception {
    touch(0, x, y);
    SystemClock.sleep(Math.max(1, durationMs));
    touch(2, x, y);
  }

  void typeText(String text) throws Exception {
    KeyEvent[] events =
        KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(text.toCharArray());
    if (events == null)
      throw new IllegalArgumentException("text is unsupported by the active key map");
    for (KeyEvent event : events)
      inject(event);
  }

  void button(int button) throws Exception {
    int keyCode;
    switch (button) {
    case 0:
      keyCode = KeyEvent.KEYCODE_BACK;
      break;
    case 1:
      keyCode = KeyEvent.KEYCODE_HOME;
      break;
    case 2:
      keyCode = KeyEvent.KEYCODE_APP_SWITCH;
      break;
    case 3:
      keyCode = KeyEvent.KEYCODE_POWER;
      break;
    case 4:
      keyCode = KeyEvent.KEYCODE_VOLUME_UP;
      break;
    case 5:
      keyCode = KeyEvent.KEYCODE_VOLUME_DOWN;
      break;
    default:
      throw new IllegalArgumentException("unsupported button");
    }
    long now = SystemClock.uptimeMillis();
    inject(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, keyCode, 0));
    inject(new KeyEvent(now, now, KeyEvent.ACTION_UP, keyCode, 0));
  }

  private void inject(InputEvent event) throws Exception {
    // Events made through the compatibility constructors have no target
    // display on newer Android releases. InputDispatcher rejects them rather
    // than implicitly choosing display 0, even for the shell UID.
    if (setDisplayId != null)
      setDisplayId.invoke(event, 0);
    // Continuous motion must not wait for every target window to finish
    // dispatching; doing so makes an isolated DOWN report a false timeout on
    // current Android even though InputDispatcher can enqueue it. Key events
    // remain synchronous so button/text acknowledgements reflect completion.
    int mode = event instanceof MotionEvent ? 0 : 2;
    boolean accepted = (Boolean)injectInputEvent.invoke(inputManager, event, mode);
    if (!accepted && !(event instanceof MotionEvent && mode == 0)) {
      String details = event.toString();
      throw new SecurityException("Android rejected the input event (" + details + ")");
    }
  }

  private int touchscreenDeviceId() {
    InputDevice cached = InputDevice.getDevice(touchscreenDeviceId);
    if (cached != null && cached.supportsSource(InputDevice.SOURCE_TOUCHSCREEN)) {
      return touchscreenDeviceId;
    }
    int selected = 0;
    float largestArea = -1;
    for (int id : InputDevice.getDeviceIds()) {
      InputDevice device = InputDevice.getDevice(id);
      if (device == null || !device.supportsSource(InputDevice.SOURCE_TOUCHSCREEN))
        continue;
      if (getAssociatedDisplayId != null) {
        try {
          if (((Integer)getAssociatedDisplayId.invoke(device)) == 0) {
            touchscreenDeviceId = id;
            return id;
          }
        } catch (ReflectiveOperationException ignored) {
        }
      }
      InputDevice.MotionRange x =
          device.getMotionRange(MotionEvent.AXIS_X, InputDevice.SOURCE_TOUCHSCREEN);
      InputDevice.MotionRange y =
          device.getMotionRange(MotionEvent.AXIS_Y, InputDevice.SOURCE_TOUCHSCREEN);
      float area = x == null || y == null ? 0 : x.getRange() * y.getRange();
      // Official multi-display emulator images expose inactive touchscreen
      // devices before the default display's device. The active phone/tablet
      // touchscreen has the largest logical motion range.
      if (area > largestArea) {
        selected = id;
        largestArea = area;
      }
    }
    touchscreenDeviceId = selected;
    return selected;
  }
}
