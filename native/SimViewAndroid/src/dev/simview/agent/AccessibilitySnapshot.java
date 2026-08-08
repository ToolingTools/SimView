package dev.simview.agent;

import android.app.UiAutomation;
import android.graphics.Rect;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/** Persistent accessibility observation for the shell agent. */
final class AccessibilitySnapshot {
  interface EventListener {
    void onAccessibilityEvent(long revision);
  }

  private static final int MAXIMUM_BYTES = 8 * 1024 * 1024;
  private static final int OBSERVED_EVENT_TYPES =
      AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
          | AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
          | AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED
          | AccessibilityEvent.TYPE_VIEW_FOCUSED
          | AccessibilityEvent.TYPE_VIEW_SELECTED
          | AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED
          | AccessibilityEvent.TYPE_VIEW_SCROLLED
          | AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED
          | AccessibilityEvent.TYPE_WINDOWS_CHANGED;

  private final EventListener listener;
  private final AtomicLong revision = new AtomicLong();
  private final UiAutomation automation;

  private AccessibilitySnapshot(EventListener listener) {
    this.listener = listener;
    this.automation = connectAutomation();
    if (automation != null) {
      automation.setOnAccessibilityEventListener(
          event -> {
            if ((event.getEventType() & OBSERVED_EVENT_TYPES) != 0) {
              listener.onAccessibilityEvent(revision.incrementAndGet());
            }
          });
    }
  }

  static AccessibilitySnapshot start(EventListener listener) {
    return new AccessibilitySnapshot(listener);
  }

  byte[] capture() throws Exception {
    if (automation != null) {
      try {
        AccessibilityNodeInfo root = automation.getRootInActiveWindow();
        if (root != null) {
          StringBuilder xml = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
          xml.append("<hierarchy rotation=\"0\">");
          appendNode(xml, root, 0);
          xml.append("</hierarchy>");
          return xml.toString().getBytes(StandardCharsets.UTF_8);
        }
      } catch (RuntimeException ignored) {
        // The private shell bootstrap is runtime-probed. Use the dump fallback
        // when an OS/runtime combination rejects UiAutomation access.
      }
    }
    return dumpHierarchy();
  }

  private static UiAutomation connectAutomation() {
    try {
      Constructor<?> constructor = UiAutomation.class.getDeclaredConstructor();
      constructor.setAccessible(true);
      UiAutomation value = (UiAutomation) constructor.newInstance();
      // `connect` is hidden on some releases and absent on others. The
      // reflection probe is deliberately bounded to this bootstrap path.
      try {
        Method connect = UiAutomation.class.getDeclaredMethod("connect");
        connect.setAccessible(true);
        connect.invoke(value);
      } catch (NoSuchMethodException ignored) {
        // Newer shell runtimes connect the instance during construction.
      }
      return value;
    } catch (Throwable ignored) {
      return null;
    }
  }

  private static void appendNode(StringBuilder xml, AccessibilityNodeInfo node, int index) {
    Rect bounds = new Rect();
    node.getBoundsInScreen(bounds);
    xml.append("<node");
    appendAttribute(xml, "index", Integer.toString(index));
    appendAttribute(xml, "text", text(node.getText()));
    appendAttribute(xml, "resource-id", node.getViewIdResourceName());
    appendAttribute(xml, "class", text(node.getClassName()));
    appendAttribute(xml, "package", text(node.getPackageName()));
    appendAttribute(xml, "content-desc", text(node.getContentDescription()));
    appendAttribute(xml, "checkable", Boolean.toString(node.isCheckable()));
    appendAttribute(xml, "checked", Boolean.toString(node.isChecked()));
    appendAttribute(xml, "clickable", Boolean.toString(node.isClickable()));
    appendAttribute(xml, "enabled", Boolean.toString(node.isEnabled()));
    appendAttribute(xml, "focusable", Boolean.toString(node.isFocusable()));
    appendAttribute(xml, "focused", Boolean.toString(node.isFocused()));
    appendAttribute(xml, "scrollable", Boolean.toString(node.isScrollable()));
    appendAttribute(xml, "selected", Boolean.toString(node.isSelected()));
    appendAttribute(xml, "visible-to-user", Boolean.toString(node.isVisibleToUser()));
    appendAttribute(
        xml,
        "bounds",
        "[" + bounds.left + "," + bounds.top + "][" + bounds.right + "," + bounds.bottom + "]");
    if (node.getChildCount() == 0) {
      xml.append("/>");
      return;
    }
    xml.append(">");
    for (int childIndex = 0; childIndex < node.getChildCount(); childIndex++) {
      AccessibilityNodeInfo child = node.getChild(childIndex);
      if (child != null) appendNode(xml, child, childIndex);
    }
    xml.append("</node>");
  }

  private static void appendAttribute(StringBuilder xml, String name, String value) {
    if (value == null || value.isEmpty()) return;
    xml.append(' ').append(name).append("=\"").append(escape(value)).append("\"");
  }

  private static String text(CharSequence value) {
    return value == null ? "" : value.toString();
  }

  private static String escape(String value) {
    return value
        .replace("&", "&amp;")
        .replace("\"", "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;");
  }

  private static byte[] dumpHierarchy() throws Exception {
    File destination = new File("/data/local/tmp/simview-" + UUID.randomUUID() + ".xml");
    try {
      Process process =
          new ProcessBuilder("uiautomator", "dump", "--compressed", destination.getAbsolutePath())
              .redirectErrorStream(true)
              .redirectOutput(new File("/dev/null"))
              .start();
      if (!process.waitFor(12, TimeUnit.SECONDS)) {
        process.destroy();
        if (!process.waitFor(1, TimeUnit.SECONDS)) process.destroyForcibly();
        process.waitFor();
        throw new IllegalStateException("uiautomator dump timed out");
      }
      int status = process.waitFor();
      if (status != 0) throw new IllegalStateException("uiautomator dump exited with " + status);
      try (FileInputStream input = new FileInputStream(destination)) {
        return drain(input);
      }
    } finally {
      if (destination.exists() && !destination.delete()) destination.deleteOnExit();
    }
  }

  private static byte[] drain(InputStream input) throws Exception {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] buffer = new byte[16 * 1024];
    int count;
    while ((count = input.read(buffer)) != -1) {
      if (output.size() + count > MAXIMUM_BYTES)
        throw new IllegalStateException("UIAutomator hierarchy exceeds 8 MiB");
      output.write(buffer, 0, count);
    }
    return output.toByteArray();
  }
}
