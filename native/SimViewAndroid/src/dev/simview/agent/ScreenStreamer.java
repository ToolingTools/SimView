package dev.simview.agent;

import android.graphics.Rect;
import android.hardware.display.VirtualDisplay;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.os.Bundle;
import android.content.res.Resources;
import android.view.Surface;
import java.io.DataOutputStream;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;

final class ScreenStreamer implements AutoCloseable {
  private static final int EVENT_CONFIGURATION = 0x40;
  private static final int EVENT_FRAME = 0x41;
  private static final int EVENT_ERROR = 0x4f;

  private final DataOutputStream output;
  private MediaCodec codec;
  private Surface inputSurface;
  private Object displayToken;
  private Thread drainThread;
  private byte[] frameBuffer = new byte[0];
  private volatile boolean running;

  ScreenStreamer(DataOutputStream output) {
    this.output = output;
  }

  void start(int requestedWidth, int requestedHeight, int bitrate, int frameRate) throws Exception {
    int[] size = constrainedSize(requestedWidth, requestedHeight, 1920);
    int width = size[0];
    int height = size[1];
    MediaFormat format =
        MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height);
    format.setInteger(MediaFormat.KEY_COLOR_FORMAT,
                      MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
    format.setInteger(MediaFormat.KEY_BIT_RATE, Math.max(250_000, bitrate));
    format.setInteger(MediaFormat.KEY_FRAME_RATE, Math.max(1, Math.min(60, frameRate)));
    format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2);
    codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
    codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
    inputSurface = codec.createInputSurface();
    displayToken = DisplayCompat.createDisplay("SimView", inputSurface, requestedWidth,
                                               requestedHeight, width, height);
    codec.start();
    running = true;
    drainThread = new Thread(this::drain, "simview-codec");
    drainThread.start();
  }

  void requestKeyframe() {
    if (codec == null)
      return;
    Bundle parameters = new Bundle();
    parameters.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
    codec.setParameters(parameters);
  }

  private void drain() {
    MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
    try {
      while (running) {
        int index = codec.dequeueOutputBuffer(info, 10_000);
        if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          writeConfiguration(codec.getOutputFormat());
        } else if (index >= 0) {
          ByteBuffer buffer = codec.getOutputBuffer(index);
          if (buffer != null && info.size > 0 &&
              (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
            if (frameBuffer.length < info.size)
              frameBuffer = new byte[info.size];
            buffer.position(info.offset);
            buffer.limit(info.offset + info.size);
            buffer.get(frameBuffer, 0, info.size);
            synchronized (output) {
              output.writeByte(EVENT_FRAME);
              output.writeLong(info.presentationTimeUs);
              output.writeBoolean((info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0);
              output.writeInt(info.size);
              output.write(frameBuffer, 0, info.size);
              output.flush();
            }
          }
          codec.releaseOutputBuffer(index, false);
        }
      }
    } catch (Exception error) {
      if (!running)
        return;
      try {
        synchronized (output) {
          output.writeByte(EVENT_ERROR);
          output.writeUTF(error.getClass().getSimpleName() + ": " + error.getMessage());
          output.flush();
        }
      } catch (Exception ignored) {
        // The host connection is already gone.
      }
    }
  }

  private void writeConfiguration(MediaFormat format) throws Exception {
    byte[] first = bytes(format.getByteBuffer("csd-0"));
    byte[] second = bytes(format.getByteBuffer("csd-1"));
    synchronized (output) {
      output.writeByte(EVENT_CONFIGURATION);
      output.writeInt(first.length);
      output.write(first);
      output.writeInt(second.length);
      output.write(second);
      output.flush();
    }
  }

  private static byte[] bytes(ByteBuffer buffer) {
    if (buffer == null)
      return new byte[0];
    ByteBuffer copy = buffer.duplicate();
    byte[] value = new byte[copy.remaining()];
    copy.get(value);
    return value;
  }

  @Override
  public void close() {
    running = false;
    if (drainThread != null)
      drainThread.interrupt();
    if (drainThread != null) {
      try {
        drainThread.join(500);
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
      }
      drainThread = null;
    }
    DisplayCompat.destroyDisplay(displayToken);
    displayToken = null;
    if (codec != null) {
      try {
        codec.stop();
      } catch (Exception ignored) {
      }
      codec.release();
      codec = null;
    }
    if (inputSurface != null)
      inputSurface.release();
    inputSurface = null;
  }

  private static int even(int value) {
    return value & ~1;
  }

  private static int[] constrainedSize(int requestedWidth, int requestedHeight,
                                       int maximumDimension) {
    int sourceWidth = Math.max(64, requestedWidth);
    int sourceHeight = Math.max(64, requestedHeight);
    double scale = Math.min(1.0, (double)maximumDimension / Math.max(sourceWidth, sourceHeight));
    int width = Math.max(64, even((int)Math.round(sourceWidth * scale)));
    int height = Math.max(64, even((int)Math.round(sourceHeight * scale)));
    return new int[] {width, height};
  }

  /** Android 12+ exposes a shell-usable mirroring virtual display entry point. */
  private static final class DisplayCompat {
    static Object createDisplay(String name, Surface surface, int sourceWidth, int sourceHeight,
                                int width, int height) throws Exception {
      try {
        Method create = android.hardware.display.DisplayManager.class.getMethod(
            "createVirtualDisplay", String.class, int.class, int.class, int.class, Surface.class);
        int densityDpi = Math.max(1, Resources.getSystem().getDisplayMetrics().densityDpi);
        Object display = create.invoke(null, name, width, height, densityDpi, surface);
        if (display != null)
          return display;
      } catch (ReflectiveOperationException unavailable) {
        // Older Android versions use the legacy SurfaceControl transaction below.
      }
      return SurfaceControlCompat.createDisplay(name, surface, sourceWidth, sourceHeight, width,
                                                height);
    }

    static void destroyDisplay(Object display) {
      if (display instanceof VirtualDisplay) {
        ((VirtualDisplay)display).release();
      } else {
        SurfaceControlCompat.destroyDisplay(display);
      }
    }
  }

  private static final class SurfaceControlCompat {
    private static final Class<?> TYPE;
    static {
      try {
        TYPE = Class.forName("android.view.SurfaceControl");
      } catch (ClassNotFoundException error) {
        throw new ExceptionInInitializerError(error);
      }
    }

    static Object createDisplay(String name, Surface surface, int sourceWidth, int sourceHeight,
                                int width, int height) throws Exception {
      Method create = TYPE.getDeclaredMethod("createDisplay", String.class, boolean.class);
      Object token = create.invoke(null, name, false);
      Method open = TYPE.getDeclaredMethod("openTransaction");
      Method close = TYPE.getDeclaredMethod("closeTransaction");
      open.invoke(null);
      try {
        TYPE.getDeclaredMethod("setDisplaySurface", android.os.IBinder.class, Surface.class)
            .invoke(null, token, surface);
        TYPE.getDeclaredMethod("setDisplayProjection", android.os.IBinder.class, int.class,
                               Rect.class, Rect.class)
            .invoke(null, token, 0, new Rect(0, 0, sourceWidth, sourceHeight),
                    new Rect(0, 0, width, height));
        TYPE.getDeclaredMethod("setDisplayLayerStack", android.os.IBinder.class, int.class)
            .invoke(null, token, 0);
      } finally {
        close.invoke(null);
      }
      return token;
    }

    static void destroyDisplay(Object token) {
      if (token == null)
        return;
      try {
        TYPE.getDeclaredMethod("destroyDisplay", android.os.IBinder.class).invoke(null, token);
      } catch (Exception ignored) {
      }
    }
  }
}
