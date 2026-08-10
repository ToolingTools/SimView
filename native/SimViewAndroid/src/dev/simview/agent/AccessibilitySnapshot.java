package dev.simview.agent;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/** Persistent accessibility observation for the shell agent. */
final class AccessibilitySnapshot {
  interface EventListener {
    void onAccessibilityEvent(long revision);
  }

  private static final int MAXIMUM_BYTES = 8 * 1024 * 1024;
  private AccessibilitySnapshot(EventListener listener) {}

  static AccessibilitySnapshot start(EventListener listener) {
    return new AccessibilitySnapshot(listener);
  }

  byte[] capture() throws Exception {
    return dumpHierarchy();
  }

  private static byte[] dumpHierarchy() throws Exception {
    File destination = new File("/data/local/tmp/simview-" + UUID.randomUUID() + ".xml");
    try {
      Process process =
          new ProcessBuilder("uiautomator", "dump", destination.getAbsolutePath())
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
