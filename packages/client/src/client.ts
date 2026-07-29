import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { resolveBinary } from "@simview/core";
import {
  FrameDecoder,
  FrameKind,
  PROTOCOL_VERSION,
  encodeFrame,
  type Codec,
  type Method,
  type ProtocolRequest,
  type ProtocolResponse,
} from "./protocol";

type DataHandler = (payload: Uint8Array) => void;

export interface SessionOptions {
  udid?: string;
  codec?: Codec;
  idleTimeoutSeconds?: number;
  binary?: string;
}

export class SimViewClient {
  readonly socketPath: string;
  readonly token: string;
  readonly process?: Bun.Subprocess;
  #socket?: Awaited<ReturnType<typeof Bun.connect>>;
  #decoder = new FrameDecoder();
  #pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }>();
  #handlers = new Map<FrameKind, Set<DataHandler>>();
  #sessionDirectory?: string;

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
    const child = Bun.spawn([
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
    ], {
      stdin: new TextEncoder().encode(token),
      stdout: "inherit",
      stderr: "inherit",
    });

    const client = new SimViewClient(socketPath, token, child);
    client.#sessionDirectory = sessionDirectory;
    await client.#waitForSocket();
    await client.connect(options.codec ?? "h264");
    return client;
  }

  static async attach(socketPath: string, token: string, codec: Codec = "h264") {
    const client = new SimViewClient(socketPath, token);
    await client.connect(codec);
    return client;
  }

  async #waitForSocket(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        await Bun.file(this.socketPath).exists();
        const socket = await Bun.connect({
          unix: this.socketPath,
          socket: { data() {}, open(sock) { sock.end(); } },
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
          for (const frame of decoder.push(new Uint8Array(data))) this.#handle(frame.kind, frame.payload);
        },
        error: (_socket, error) => this.#rejectAll(error),
        close: () => this.#rejectAll(new Error("simview-core connection closed")),
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
      const response = JSON.parse(new TextDecoder().decode(payload)) as ProtocolResponse;
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      if (response.error) pending.reject(Object.assign(new Error(response.error.message), response.error));
      else pending.resolve(response.result);
      return;
    }
    for (const handler of this.#handlers.get(kind) ?? []) handler(payload);
  }

  #rejectAll(error: unknown): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  on(kind: FrameKind, handler: DataHandler): () => void {
    const handlers = this.#handlers.get(kind) ?? new Set<DataHandler>();
    handlers.add(handler);
    this.#handlers.set(kind, handlers);
    return () => handlers.delete(handler);
  }

  async request<T = unknown>(method: Method, params: unknown = {}): Promise<T> {
    if (!this.#socket) throw new Error("SimView client is not connected");
    const id = randomUUID();
    const request: ProtocolRequest = { id, protocolVersion: PROTOCOL_VERSION, method, params };
    const payload = new TextEncoder().encode(JSON.stringify(request));
    const promise = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
      });
    });
    this.#socket.write(encodeFrame(FrameKind.Request, payload));
    return promise;
  }

  async close(): Promise<void> {
    this.#socket?.end();
    this.#socket = undefined;
    if (this.process) {
      this.process.kill();
      await this.process.exited;
    }
    if (this.#sessionDirectory) await rm(this.#sessionDirectory, { recursive: true, force: true });
  }
}
