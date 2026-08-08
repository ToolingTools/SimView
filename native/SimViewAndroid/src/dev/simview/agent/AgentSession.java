package dev.simview.agent;

import java.io.DataInputStream;
import java.io.DataOutputStream;

final class AgentSession {
  private static final int START_CAPTURE = 0x10;
  private static final int REQUEST_KEYFRAME = 0x11;
  private static final int TOUCH = 0x20;
  private static final int TAP = 0x21;
  private static final int TYPE_TEXT = 0x22;
  private static final int BUTTON = 0x23;
  private static final int GESTURE = 0x24;
  private static final int ACCESSIBILITY_SNAPSHOT = 0x30;
  private static final int SHUTDOWN = 0x7f;
  private static final int EVENT_ACKNOWLEDGEMENT = 0x42;
  private static final int EVENT_RESPONSE = 0x43;

  private final DataInputStream input;
  private final DataOutputStream output;
  private InputDispatcher inputDispatcher;
  private ScreenStreamer streamer;

  AgentSession(DataInputStream input, DataOutputStream output) {
    this.input = input;
    this.output = output;
  }

  void run() throws Exception {
    try {
      while (true) {
        int command = input.readUnsignedByte();
        try {
          switch (command) {
          case START_CAPTURE:
            stopCapture();
            streamer = new ScreenStreamer(output);
            streamer.start(input.readInt(), input.readInt(), input.readInt(), input.readInt());
            break;
          case REQUEST_KEYFRAME:
            requireStreamer().requestKeyframe();
            break;
          case TOUCH:
            inputDispatcher().touch(input.readUnsignedByte(), input.readFloat(), input.readFloat());
            break;
          case TAP:
            inputDispatcher().tap(input.readFloat(), input.readFloat(), input.readInt());
            break;
          case TYPE_TEXT:
            inputDispatcher().typeText(input.readUTF());
            break;
          case BUTTON:
            inputDispatcher().button(input.readUnsignedByte());
            break;
          case GESTURE:
            int trackCount = input.readUnsignedByte();
            if (trackCount < 1 || trackCount > 2)
              throw new IllegalArgumentException("gesture requires one or two tracks");
            InputDispatcher.Track[] tracks = new InputDispatcher.Track[trackCount];
            for (int trackIndex = 0; trackIndex < trackCount; trackIndex++) {
              int pointerId = input.readUnsignedByte();
              int pointCount = input.readUnsignedShort();
              if (pointCount < 2 || pointCount > 120)
                throw new IllegalArgumentException("gesture track requires 2 through 120 points");
              float[] xs = new float[pointCount];
              float[] ys = new float[pointCount];
              int[] timestamps = new int[pointCount];
              for (int pointIndex = 0; pointIndex < pointCount; pointIndex++) {
                xs[pointIndex] = input.readFloat();
                ys[pointIndex] = input.readFloat();
                timestamps[pointIndex] = input.readInt();
              }
              tracks[trackIndex] = new InputDispatcher.Track(pointerId, xs, ys, timestamps);
            }
            inputDispatcher().gesture(tracks);
            break;
          case ACCESSIBILITY_SNAPSHOT:
            respond(command, AccessibilitySnapshot.capture());
            break;
          case SHUTDOWN:
            return;
          default:
            throw new IllegalArgumentException("unknown command");
          }
          acknowledge(command, null);
        } catch (Exception error) {
          acknowledge(command, error);
          if (command == START_CAPTURE || command == REQUEST_KEYFRAME)
            throw error;
        }
      }
    } finally {
      if (inputDispatcher != null)
        inputDispatcher.cancelActiveTouch();
      stopCapture();
    }
  }

  private void acknowledge(int command, Exception error) throws Exception {
    synchronized (output) {
      output.writeByte(EVENT_ACKNOWLEDGEMENT);
      output.writeByte(command);
      output.writeByte(error == null ? 0 : 1);
      if (error != null)
        output.writeUTF(error.getClass().getSimpleName() + ": " + error.getMessage());
      output.flush();
    }
  }

  private void respond(int command, byte[] payload) throws Exception {
    synchronized (output) {
      output.writeByte(EVENT_RESPONSE);
      output.writeByte(command);
      output.writeInt(payload.length);
      output.write(payload);
      output.flush();
    }
  }

  private ScreenStreamer requireStreamer() {
    if (streamer == null)
      throw new IllegalStateException("capture has not started");
    return streamer;
  }

  private InputDispatcher inputDispatcher() {
    if (inputDispatcher == null)
      inputDispatcher = new InputDispatcher();
    return inputDispatcher;
  }

  private void stopCapture() {
    if (streamer != null)
      streamer.close();
    streamer = null;
  }
}
