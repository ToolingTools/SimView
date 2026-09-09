import { closeSync, constants, fstatSync, ftruncateSync, openSync, writeSync } from "node:fs";
import type { OwnerExitReason, OwnerInspectionEvent } from "@simview/client";

import type { NativeDisconnectReason } from "@simview/contracts";

export type DiagnosticReason =
  | `native_${NativeDisconnectReason}`
  | OwnerExitReason
  | OwnerInspectionEvent
  | "stdin_end"
  | "stdin_close"
  | "stdin_error"
  | "stdout_close"
  | "stdout_error"
  | "sigint"
  | "sigterm"
  | "disconnect"
  | "socket_error"
  | "socket_close"
  | "socket_end"
  | "adapter_error"
  | "adapter_finished"
  | "last_connection_closed"
  | "shutdown_timeout"
  | "startup_timeout"
  | "server_error"
  | "protocol_error"
  | "protocol_close"
  | "handshake_rejected";
export const DIAGNOSTIC_LIMIT = 64 * 1024;

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

// Never serialize error messages, stacks, or arbitrary error codes: they can
// contain authentication payloads, environment values, or device contents.
function diagnosticCategory(
  error: unknown,
): "none" | "permission" | "connection" | "timeout" | "other" {
  if (error === undefined) return "none";
  const code = errorCode(error);
  switch (code) {
    case "EPERM":
    case "EACCES":
      return "permission";
    case "EPIPE":
    case "ECONNRESET":
      return "connection";
    case "ETIMEDOUT":
      return "timeout";
    default:
      return "other";
  }
}

export function diagnosticLine(
  component: "adapter" | "daemon",
  reason: DiagnosticReason,
  error?: unknown,
): string {
  const category = diagnosticCategory(error);
  return `${JSON.stringify({ time: new Date().toISOString(), component, reason, category })}\n`;
}

export function adapterDiagnostic(reason: DiagnosticReason, error?: unknown): void {
  try {
    writeSync(2, diagnosticLine("adapter", reason, error));
  } catch {
    // Diagnostics must never interfere with shutdown, including a closed stderr.
  }
}

/** The caller supplies a path in the already-validated private MCP registry. */
export function daemonDiagnostic(path: string, reason: DiagnosticReason, error?: unknown): void {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_APPEND |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1
    )
      return;
    const line = diagnosticLine("daemon", reason, error);
    if (stat.size + Buffer.byteLength(line) > DIAGNOSTIC_LIMIT) ftruncateSync(fd, 0);
    writeSync(fd, line);
  } catch {
    // A logging failure must not turn a recoverable condition into a disconnect.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Closing a diagnostic file is best-effort too.
      }
    }
  }
}

export function classifyNativeDisconnect(error: unknown): NativeDisconnectReason {
  const code = errorCode(error);
  switch (code) {
    case "SIMVIEW_CONNECTION_CLOSED":
      return "connection_closed";
    case "SIMVIEW_REQUEST_QUEUE_EXCEEDED":
      return "request_queue_exceeded";
    case "SIMVIEW_CLIENT_CLOSED":
      return "client_closed";
    case "ECONNRESET":
    case "ECONNREFUSED":
    case "EPIPE":
      return "connection_error";
    case "EPERM":
    case "EACCES":
      return "permission_denied";
    case "ETIMEDOUT":
      return "timeout";
    default:
      return "unknown";
  }
}
