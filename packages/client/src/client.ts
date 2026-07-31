import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBinary } from "@simview/core";
import {
  type Codec,
  type DeviceDescription,
  deviceDescriptionSchema,
  encodeFrame,
  FrameDecoder,
  FrameKind,
  type Method,
  type ParamsFor,
  PROTOCOL_VERSION,
  type ProtocolRequest,
  type ProtocolResponse,
  parseMethodParams,
  parseMethodResult,
  protocolResponseSchema,
  type ResultFor,
} from "./protocol";

type DataHandler = (payload: Uint8Array) => void;

export interface SessionOptions {
  udid?: string | undefined;
  codec?: Codec | undefined;
  idleTimeoutSeconds?: number | undefined;
  binary?: string | undefined;
}

export interface AcquireOptions {
  udid: string;
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
        ...(options.udid ? ["--udid", options.udid] : []),
      ],
      {
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
    if (process.env.SIMVIEW_BACKEND_MODE === "ephemeral") return SimViewClient.start(options);
    const { acquireDaemon } = await import("./daemon");
    return acquireDaemon(options, SimViewClient);
  }

  static async listDevices(binary = resolveBinary()): Promise<DeviceDescription[]> {
    const child = Bun.spawn([binary, "devices"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(stderr.trim() || "Unable to list iOS Simulators");
    return deviceDescriptionSchema.array().parse(JSON.parse(stdout));
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
    const decoder = this.#decoder;
    this.#socket = await Bun.connect({
      unix: this.socketPath,
      socket: {
        data: (_socket, data) => {
          for (const frame of decoder.push(new Uint8Array(data)))
            this.#handle(frame.kind, frame.payload);
        },
        error: (_socket, error) => this.#rejectAll(error),
        close: () => this.#rejectAll(new Error("simview-core connection closed")),
        drain: () => this.#flushWrites(),
      },
    });
    await this.request("hello", {
      token: this.token,
      codecs: [codec, codec === "h264" ? "mjpeg" : "h264"],
      maxFrameRate: 60,
    });
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
    if (!this.#socket) throw new Error("SimView client is not connected");
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
      const timeoutMs = options.timeoutMs ?? 10_000;
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
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
      this.#rejectAll(new Error("simview-core request queue exceeded 1024 frames"));
      this.#socket.end();
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
        this.#rejectAll(new Error("simview-core connection closed while writing"));
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
    this.#socket?.end();
    this.#socket = undefined;
    this.#writeQueue = [];
    this.#writeOffset = 0;
    if (this.process) {
      this.process.kill();
      const exited = await Promise.race([
        this.process.exited.then(() => true),
        Bun.sleep(2_000).then(() => false),
      ]);
      if (!exited) {
        this.process.kill(9);
        await this.process.exited;
      }
    }
    if (this.#sessionDirectory) await rm(this.#sessionDirectory, { recursive: true, force: true });
  }
}
