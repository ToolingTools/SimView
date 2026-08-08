package dev.simview.agent;

import android.net.LocalServerSocket;
import android.net.LocalSocket;
import java.io.BufferedReader;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Transient shell-user agent. No application package or persistent service is installed. */
public final class Main {
  static final int MAGIC = 0x53564131; // SVA1
  static final int PROTOCOL_VERSION = 3;

  private Main() {}

  public static void main(String[] args) throws Exception {
    String socketName = argument(args, "--socket");
    String token =
        new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8)).readLine();
    if (socketName == null || token == null || token.getBytes(StandardCharsets.UTF_8).length < 32) {
      throw new IllegalArgumentException("socket and a 32-byte token are required");
    }
    try (LocalServerSocket server = new LocalServerSocket(socketName);
         LocalSocket socket = server.accept();
         DataInputStream input = new DataInputStream(socket.getInputStream());
         DataOutputStream output = new DataOutputStream(socket.getOutputStream())) {
      authenticate(input, output, token);
      try {
        new AgentSession(input, output).run();
      } catch (Throwable error) {
        error.printStackTrace(System.err);
        synchronized (output) {
          output.writeByte(0x4f);
          output.writeUTF(error.getClass().getSimpleName() + ": " + error.getMessage());
          output.flush();
        }
        throw error;
      } finally {
        System.err.println("SimView Android agent session ended");
      }
    }
  }

  private static void authenticate(DataInputStream input, DataOutputStream output, String token)
      throws Exception {
    int magic = input.readInt();
    int version = input.readInt();
    int tokenLength = input.readInt();
    if (magic != MAGIC || version != PROTOCOL_VERSION || tokenLength < 32 || tokenLength > 4096) {
      throw new SecurityException("invalid agent handshake");
    }
    byte[] supplied = new byte[tokenLength];
    input.readFully(supplied);
    boolean authenticated = MessageDigest.isEqual(token.getBytes(StandardCharsets.UTF_8), supplied);
    output.writeInt(MAGIC);
    output.writeInt(PROTOCOL_VERSION);
    output.writeInt(authenticated ? 0 : 1);
    output.flush();
    if (!authenticated)
      throw new SecurityException("invalid agent token");
  }

  private static String argument(String[] args, String name) {
    for (int index = 0; index + 1 < args.length; index++) {
      if (name.equals(args[index]))
        return args[index + 1];
    }
    return null;
  }
}
