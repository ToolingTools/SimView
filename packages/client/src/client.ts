import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  deviceId?: string | undefined;
  udid?: string | undefined;
  codec?: Codec | undefined;
  idleTimeoutSeconds?: number | undefined;
  binary?: string | undefined;
}

export interface AcquireOptions {
  environment?: Record<string, string> | undefined;
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
    const child = Bun.spawn(
      [
        options.binary ?? resolveBinary(),
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
        env: options.environment ?? process.env,
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
  ): Promise<DeviceDescription[]> {
    const child = Bun.spawn([binary, "devices"], {
      env: environment ?? process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(stderr.trim() || "Unable to list devices");
    const payload: unknown = JSON.parse(stdout);
    if (!Array.isArray(payload)) throw new Error("Device list is not an array");
    return payload.map(parseDeviceDescription);
  }

  static async attach(socketPath: string, token: string, codec: Codec = "h264") {
    const client = new SimViewClient(socketPath, token);
    try {
      await client.connect(codec);
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

  async connect(codec: Codec = "h264"): Promise<void> {
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
        close: () => this.#disconnect(new Error("simview-core connection closed")),
        drain: () => this.#flushWrites(),
      },
    });
    this.#socket = socket;
    this.#connected = true;
    try {
      await this.request("hello", {
        token: this.token,
        codecs: [codec, codec === "h264" ? "mjpeg" : "h264"],
        maxFrameRate: 60,
      });
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
      // Emulator console rotation is asynchronous and may require up to three
      // clockwise transitions. Keep the ordinary protocol deadline tight while
      // allowing this explicitly slow device operation to finish honestly.
      const timeoutMs =
        options.timeoutMs ?? (method === "device.orientation.set" ? 30_000 : 10_000);
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
      this.#disconnect(new Error("simview-core request queue exceeded 1024 frames"));
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
        this.#disconnect(new Error("simview-core connection closed while writing"));
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

    this.#disconnect(new Error("SimView client closed"));
    if (this.#sessionDirectory) await rm(this.#sessionDirectory, { recursive: true, force: true });
  }
}
