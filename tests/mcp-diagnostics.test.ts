import { expect, test } from "bun:test";
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyNativeDisconnect,
  DIAGNOSTIC_LIMIT,
  daemonDiagnostic,
  diagnosticLine,
} from "../packages/mcp/src/diagnostics";

test("diagnostics exclude arbitrary error contents and codes", () => {
  const secret = "capability-token-device-content";
  for (const [code, category] of [
    [secret, "other"],
    ["EPERM", "permission"],
    ["EACCES", "permission"],
    ["ETIMEDOUT", "timeout"],
    ["EPIPE", "connection"],
    ["ECONNRESET", "connection"],
  ]) {
    const line = diagnosticLine(
      "daemon",
      "protocol_error",
      Object.assign(new Error(secret), { code }),
    );
    expect(line).not.toContain(secret);
    expect(JSON.parse(line).category).toBe(category);
    expect(Object.keys(JSON.parse(line))).toEqual(["time", "component", "reason", "category"]);
  }
  expect(JSON.parse(diagnosticLine("adapter", "stdin_end")).category).toBe("none");
  for (const error of [null, secret, {}, new Error(secret)]) {
    const line = diagnosticLine("daemon", "protocol_error", error);
    expect(JSON.parse(line).category).toBe("other");
    expect(line).not.toContain(secret);
  }
});

test("daemon diagnostics are private, bounded, retained, and refuse unsafe files", async () => {
  const root = await mkdtemp(join(tmpdir(), "simview-diagnostics-test-"));
  const path = join(root, "diagnostics.log");
  try {
    daemonDiagnostic(path, "owner_inspection_failed");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await writeFile(path, "x".repeat(DIAGNOSTIC_LIMIT));
    daemonDiagnostic(path, "owner_inspection_recovered");
    expect((await stat(path)).size).toBeLessThanOrEqual(DIAGNOSTIC_LIMIT);
    expect(JSON.parse(await readFile(path, "utf8")).reason).toBe("owner_inspection_recovered");
    const unsafe = join(root, "unsafe.log");
    await symlink(path, unsafe);
    const before = await readFile(path, "utf8");
    daemonDiagnostic(unsafe, "protocol_error");
    expect(await readFile(path, "utf8")).toBe(before);
    await rm(unsafe);
    await link(path, unsafe);
    daemonDiagnostic(unsafe, "protocol_error");
    expect(await readFile(path, "utf8")).toBe(before);
    await rm(unsafe);
    await chmod(path, 0o644);
    daemonDiagnostic(path, "protocol_error");
    expect(await readFile(path, "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native disconnect classification never includes arbitrary error data", () => {
  const cases = {
    SIMVIEW_CONNECTION_CLOSED: "connection_closed",
    SIMVIEW_REQUEST_QUEUE_EXCEEDED: "request_queue_exceeded",
    SIMVIEW_CLIENT_CLOSED: "client_closed",
    ECONNRESET: "connection_error",
    EPIPE: "connection_error",
    ECONNREFUSED: "connection_error",
    EPERM: "permission_denied",
    EACCES: "permission_denied",
    ETIMEDOUT: "timeout",
    "secret-token-and-ui-content": "unknown",
  } as const;
  for (const [code, expected] of Object.entries(cases)) {
    const error = Object.assign(new Error("secret-token-and-ui-content"), { code });
    const reason = classifyNativeDisconnect(error);
    expect(reason).toBe(expected);
    expect(diagnosticLine("daemon", `native_${reason}`, error)).not.toContain(
      "secret-token-and-ui-content",
    );
  }
  expect(classifyNativeDisconnect(new Error("private payload"))).toBe("unknown");
});
