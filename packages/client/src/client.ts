import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { resolveBinary } from "@simview/core";
import {
  type Codec,
  type DeviceDescription,
  encodeFrame,
  FrameDecoder,
  FrameKind,
  type Method,
  type ParamsFor,
  PROTOCOL_VERSION,
  type ProtocolRequest,
  type ProtocolResponse,
  parseDeviceDescription,
  parseMethodParams,
  parseMethodResult,
  protocolResponseSchema,
  type ResultFor,
} from "./protocol";

type DataHandler = (payload: Uint8Array) => void;

export interface SessionOptions {
  environment?: Record<string, string> | undefined;
  cwd?: string | undefined;
  deviceId?: string | undefined;
  udid?: string | undefined;
  codec?: Codec | undefined;
  idleTimeoutSeconds?: number | undefined;
  binary?: string | undefined;
}

export interface AcquireOptions {
  environment?: Record<string, string> | undefined;
  cwd?: string | undefined;
  backendMode?: "shared" | "ephemeral" | undefined;
  deviceId?: string | undefined;
  udid?: string | undefined;
  codec?: Codec | undefined;
  binary?: string | undefined;
}

export interface RequestOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface ListDevicesOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  cwd?: string | undefined;
}

const pathEnvironmentKeys = new Set([
  "DEVELOPER_DIR",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "SIMVIEW_ADB_PATH",
  "SIMVIEW_ANDROID_AGENT_PATH",
  "SIMVIEW_PROBE_DYLIB",
  "SIMVIEW_XCTEST_PROVIDER_XCTESTRUN",
]);

/** Resolve the exact native environment used by a child, including relative overrides. */
export function resolveNativeEnvironment(
  environment: Record<string, string> | undefined,
  cwd = process.cwd(),
): Record<string, string> {
  const base = environment ?? process.env;
  const resolvedCwd = resolve(cwd);
  return Object.fromEntries(
    Object.entries(base).flatMap(([key, value]) => {
      if (value === undefined) return [];
      if (key === "PATH") {
        return [
          [
            key,
            value
              .split(delimiter)
              .map((entry) => {
                if (entry === "") return resolvedCwd;
                return isAbsolute(entry) ? entry : resolve(resolvedCwd, entry);
              })
              .join(delimiter),
          ],
        ];
      }
      return [
        [
          key,
          pathEnvironmentKeys.has(key) && value !== "" && !isAbsolute(value)
            ? resolve(resolvedCwd, value)
            : value,
        ],
      ];
    }),
  );
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The process group may have already exited; the direct child is handled below.
  }
}

async function terminateProcess(child: Bun.Subprocess): Promise<void> {
  if (child.exitCode !== null) {
    signalProcessGroup(child.pid, "SIGTERM");
    signalProcessGroup(child.pid, "SIGKILL");
    return;
  }
  signalProcessGroup(child.pid, "SIGTERM");
  if (child.exitCode === null) child.kill();
  const exited = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(2_000).then(() => false),
  ]);
  signalProcessGroup(child.pid, "SIGKILL");
  if (!exited && child.exitCode === null) {
    child.kill(9);
    await child.exited;
  }
}

interface PendingRequest {
  method: Method;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  cleanup: () => void;
}

export class SimViewClient {
  readonly socketPath: string;
  readonly token: string;
  readonly process: Bun.Subprocess | undefined;
  #socket: Awaited<ReturnType<typeof Bun.connect>> | undefined;
  #decoder = new FrameDecoder();
  #pending = new Map<string, PendingRequest>();
  #handlers = new Map<FrameKind, Set<DataHandler>>();
  #writeQueue: Uint8Array[] = [];
  #writeOffset = 0;
  #sessionDirectory: string | undefined;
  #connected = false;
  #disconnectHandlers = new Set<(error: Error) => void>();

  private constructor(socketPath: string, token: string, process?: Bun.Subprocess) {
    this.socketPath = socketPath;
    this.token = token;
    this.process = process;
  }

  static async start(options: SessionOptions = {}): Promise<SimViewClient> {
    const sessionDirectory = await mkdtemp(join(tmpdir(), "simview-"));
    await chmod(sessionDirectory, 0o700);
    const socketPath = join(sessionDirectory, "core.sock");
    const token = randomBytes(32).toString("hex");
    const cwd = resolve(options.cwd ?? process.cwd());
    const binary = resolve(cwd, options.binary ?? resolveBinary());
    const child = Bun.spawn(
      [
        binary,
        "serve",
        "--socket",
        socketPath,
        "--token-fd",
        "0",
        "--parent-pid",
        String(process.pid),
        "--idle-timeout",
        String(options.idleTimeoutSeconds ?? 60),
        ...(options.deviceId
          ? ["--device-id", options.deviceId]
          : options.udid
            ? ["--udid", options.udid]
            : []),
      ],
      {
        cwd,
        env: resolveNativeEnvironment(options.environment, cwd),
        stdin: new TextEncoder().encode(token),
        stdout: "inherit",
        stderr: "inherit",
      },
    );

    const client = new SimViewClient(socketPath, token, child);
    client.#sessionDirectory = sessionDirectory;
    try {
      await client.#waitForSocket();
      await client.connect(options.codec ?? "h264");
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  static async acquire(options: AcquireOptions): Promise<SimViewClient> {
    if ((options.backendMode ?? process.env.SIMVIEW_BACKEND_MODE) === "ephemeral")
      return SimViewClient.start(options);
    const { acquireDaemon } = await import("./daemon");
    return acquireDaemon(options, SimViewClient);
  }

  static async listDevices(
    binary = resolveBinary(),
    environment?: Record<string, string>,
    options: ListDevicesOptions = {},
  ): Promise<DeviceDescription[]> {
    if (options.signal?.aborted)
      throw options.signal.reason ?? new DOMException("Request aborted", "AbortError");
    const cwd = resolve(options.cwd ?? process.cwd());
    const child = Bun.spawn([resolve(cwd, binary), "devices"], {
      cwd,
      env: resolveNativeEnvironment(environment, cwd),
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    const output = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ] as const);
    const timeoutMs = options.timeoutMs ?? 10_000;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancel!: () => void;
    const cancellation = new Promise<never>((_, reject) => {
      cancel = () =>
        reject(options.signal?.reason ?? new DOMException("Request aborted", "AbortError"));
    });
    const timeoutFailure = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`devices timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    const abort = () => cancel();
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const [stdout, stderr, exitCode] = await Promise.race([output, cancellation, timeoutFailure]);
      if (exitCode !== 0) throw new Error(stderr.trim() || "Unable to list devices");
      const payload: unknown = JSON.parse(stdout);
      if (!Array.isArray(payload)) throw new Error("Device list is not an array");
      return payload.map(parseDeviceDescription);
    } finally {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      await terminateProcess(child);
    }
  }

  static async attach(
    socketPath: string,
    token: string,
    codec: Codec = "h264",
    options: RequestOptions = {},
  ) {
    const client = new SimViewClient(socketPath, token);
    try {
      await client.connect(codec, options);
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  get connected(): boolean {
    return this.#connected;
  }

  onDisconnect(handler: (error: Error) => void): () => void {
    this.#disconnectHandlers.add(handler);
    return () => this.#disconnectHandlers.delete(handler);
  }

  async #waitForSocket(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        await Bun.file(this.socketPath).exists();
        const socket = await Bun.connect({
          unix: this.socketPath,
          socket: {
            data() {},
            open(sock) {
              sock.end();
            },
          },
        });
        socket.end();
        return;
      } catch {
        await Bun.sleep(25);
      }
    }
    throw new Error("Timed out waiting for simview-core socket");
  }

  async connect(codec: Codec = "h264", options: RequestOptions = {}): Promise<void> {
    if (this.#connected) throw new Error("SimView client is already connected");
    const decoder = this.#decoder;
    const socket = await Bun.connect({
      unix: this.socketPath,
      socket: {
        data: (_socket, data) => {
          for (const frame of decoder.push(new Uint8Array(data)))
            this.#handle(frame.kind, frame.payload);
        },
        error: (_socket, error) => this.#disconnect(error),
        close: () =>
          this.#disconnect(
            Object.assign(new Error("simview-core connection closed"), {
              code: "SIMVIEW_CONNECTION_CLOSED",
            }),
          ),
        drain: () => this.#flushWrites(),
      },
    });
    this.#socket = socket;
    this.#connected = true;
    try {
      await this.request(
        "hello",
        {
          token: this.token,
          codecs: [codec, codec === "h264" ? "mjpeg" : "h264"],
          maxFrameRate: 60,
        },
        options,
      );
    } catch (error) {
      this.#disconnect(error);
      throw error;
    }
  }

  #handle(kind: FrameKind, payload: Uint8Array): void {
    if (kind === FrameKind.Response) {
      let response: ProtocolResponse;
      try {
        response = protocolResponseSchema.parse(JSON.parse(new TextDecoder().decode(payload)));
      } catch (error) {
        this.#rejectAll(
          new Error("simview-core returned an invalid protocol response", {
            cause: error,
          }),
        );
        return;
      }
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      pending.cleanup();
      if (response.error) {
        pending.reject(Object.assign(new Error(response.error.message), response.error));
      } else {
        try {
          pending.resolve(parseMethodResult(pending.method, response.result));
        } catch (error) {
          pending.reject(
            new Error(`Invalid ${pending.method} result from simview-core`, {
              cause: error,
            }),
          );
        }
      }
      return;
    }
    for (const handler of this.#handlers.get(kind) ?? []) handler(payload);
  }

  #rejectAll(error: unknown): void {
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.#pending.clear();
    this.#writeQueue = [];
    this.#writeOffset = 0;
  }

  #disconnect(reason: unknown): void {
    if (!this.#connected && !this.#socket) return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    const socket = this.#socket;
    this.#socket = undefined;
    this.#connected = false;
    this.#rejectAll(error);
    socket?.end();
    for (const handler of this.#disconnectHandlers) {
      try {
        handler(error);
      } catch {
        // One observer must not prevent the remaining owners from invalidating their state.
      }
    }
  }

  on(kind: FrameKind, handler: DataHandler): () => void {
    const handlers = this.#handlers.get(kind) ?? new Set<DataHandler>();
    handlers.add(handler);
    this.#handlers.set(kind, handlers);
    return () => handlers.delete(handler);
  }

  async request<M extends Method>(
    method: M,
    params: ParamsFor<M>,
    options: RequestOptions = {},
  ): Promise<ResultFor<M>> {
    if (!this.#connected || !this.#socket) throw new Error("SimView client is not connected");
    if (options.signal?.aborted) throw options.signal.reason;
    const id = randomUUID();
    const validatedParams = parseMethodParams(method, params);
    const request: ProtocolRequest<M> = {
      id,
      protocolVersion: PROTOCOL_VERSION,
      method,
      params: validatedParams,
    };
    const payload = new TextEncoder().encode(JSON.stringify(request));
    const promise = new Promise<ResultFor<M>>((resolve, reject) => {
      // XCTest startup has a thirty-second native budget plus cleanup. Ordinary
      // requests must not time it out and queue a fallback behind the same startup.
      let defaultTimeoutMs = 10_000;
      if (method === "device.orientation.set") defaultTimeoutMs = 30_000;
      if (method === "accessibility.enableXCTestProvider") defaultTimeoutMs = 40_000;
      const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        options.signal?.removeEventListener("abort", abort);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const abort = () => {
        this.#pending.delete(id);
        clearTimeout(timeout);
        reject(options.signal?.reason ?? new DOMException("Request aborted", "AbortError"));
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, {
        method,
        resolve: (value) => resolve(value as ResultFor<M>),
        reject,
        cleanup: () => {
          clearTimeout(timeout);
          options.signal?.removeEventListener("abort", abort);
        },
      });
    });
    if (this.#writeQueue.length >= 1_024) {
      this.#disconnect(
        Object.assign(new Error("simview-core request queue exceeded 1024 frames"), {
          code: "SIMVIEW_REQUEST_QUEUE_EXCEEDED",
        }),
      );
      return promise;
    }
    this.#writeQueue.push(encodeFrame(FrameKind.Request, payload));
    this.#flushWrites();
    return promise;
  }

  #flushWrites(): void {
    const socket = this.#socket;
    if (!socket) return;
    while (this.#writeQueue.length > 0) {
      const frame = this.#writeQueue[0];
      if (!frame) return;
      const written = socket.write(frame, this.#writeOffset, frame.byteLength - this.#writeOffset);
      if (written < 0) {
        this.#disconnect(
          Object.assign(new Error("simview-core connection closed while writing"), {
            code: "SIMVIEW_CONNECTION_CLOSED",
          }),
        );
        return;
      }
      if (written === 0) return;
      this.#writeOffset += written;
      if (this.#writeOffset < frame.byteLength) return;
      this.#writeQueue.shift();
      this.#writeOffset = 0;
    }
  }

  async close(): Promise<void> {
    const ownedProcess = this.process;
    if (ownedProcess && this.#socket) {
      // Give an ephemeral backend the opportunity to remove device-side files,
      // ADB forwarding rules, and other resources that a signal cannot clean up.
      // Attached clients must never shut down their shared daemon.
      await this.request("server.shutdown", {}, { timeoutMs: 1_000 }).catch(() => {});
    }

    let exited = !ownedProcess;
    if (ownedProcess) {
      exited = await Promise.race([
        ownedProcess.exited.then(() => true),
        Bun.sleep(2_000).then(() => false),
      ]);
      if (!exited) {
        ownedProcess.kill();
        exited = await Promise.race([
          ownedProcess.exited.then(() => true),
          Bun.sleep(2_000).then(() => false),
        ]);
      }
      if (!exited) {
        ownedProcess.kill(9);
        await ownedProcess.exited;
      }
    }

    this.#disconnect(
      Object.assign(new Error("SimView client closed"), { code: "SIMVIEW_CLIENT_CLOSED" }),
    );
    if (this.#sessionDirectory) await rm(this.#sessionDirectory, { recursive: true, force: true });
  }
}
