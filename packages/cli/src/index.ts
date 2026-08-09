#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  compactAccessibilityTree,
  daemonStatuses,
  type ElementTreeOutput,
  FrameKind,
  pruneDaemons,
  SimViewClient,
  stopDaemons,
} from "@simview/client";
import {
  accessibilitySelectorSchema,
  type DeviceDescription,
  parseDeviceDescription,
  SIMVIEW_VERSION,
} from "@simview/contracts";
import { resolveBinary } from "@simview/core";
import { runServer, SimViewSession } from "@simview/mcp";

type Options = Record<string, string | boolean | undefined>;
type OptionDefinition = { type: "string" | "boolean"; short?: string };

const commonOptions: Record<string, OptionDefinition> = {
  "device-id": { type: "string" },
  udid: { type: "string" },
  json: { type: "boolean" },
};

const commandOptions: Record<string, Record<string, OptionDefinition>> = {
  devices: { booted: { type: "boolean" }, json: { type: "boolean" } },
  doctor: { json: { type: "boolean" } },
  preview: {
    "device-id": { type: "string" },
    udid: { type: "string" },
    "no-open": { type: "boolean" },
    "print-url": { type: "boolean" },
  },
  screenshot: {
    "device-id": { type: "string" },
    udid: { type: "string" },
    output: { type: "string", short: "o" },
  },
  observe: {
    ...commonOptions,
    scope: { type: "string" },
    output: { type: "string", short: "o" },
  },
  tree: { ...commonOptions, scope: { type: "string" } },
  "ax-tree": { ...commonOptions, scope: { type: "string" } },
  find: selectorOptions(true),
  "inspect-point": {
    ...commonOptions,
    x: { type: "string" },
    y: { type: "string" },
  },
  "tap-element": selectorOptions(true),
  wait: {
    ...selectorOptions(true),
    state: { type: "string" },
    "timeout-ms": { type: "string" },
  },
  probe: { ...commonOptions, "bundle-id": { type: "string" } },
  tap: {
    "device-id": { type: "string" },
    udid: { type: "string" },
    x: { type: "string" },
    y: { type: "string" },
  },
  swipe: {
    "device-id": { type: "string" },
    udid: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    "duration-ms": { type: "string" },
  },
  type: { "device-id": { type: "string" }, udid: { type: "string" } },
  button: { "device-id": { type: "string" }, udid: { type: "string" } },
  daemon: {
    "device-id": { type: "string" },
    udid: { type: "string" },
    all: { type: "boolean" },
    json: { type: "boolean" },
  },
  mcp: {},
  help: {},
};

function selectorOptions(includeCommon: boolean): Record<string, OptionDefinition> {
  return {
    ...(includeCommon ? commonOptions : {}),
    id: { type: "string" },
    role: { type: "string" },
    name: { type: "string" },
    value: { type: "string" },
    contains: { type: "boolean" },
    index: { type: "string" },
  };
}

function parse(argv: string[]): { command: string; positional: string[]; options: Options } {
  const command = argv[2] ?? "help";
  if (command === "--version" || command === "-v") {
    return { command: "version", positional: [], options: {} };
  }
  if (command === "serve") {
    return { command, positional: argv.slice(3), options: {} };
  }
  const options = commandOptions[command];
  if (!options) throw new Error(`Unknown command: ${command}`);
  const parsed = parseArgs({
    args: argv.slice(3),
    options,
    allowPositionals: true,
    strict: true,
  });
  return {
    command,
    positional: parsed.positionals,
    options: parsed.values as Options,
  };
}

async function coreJSON(command: "doctor" | "devices"): Promise<unknown> {
  const child = Bun.spawn([resolveBinary(), command], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) throw new Error(stderr.trim() || `${command} failed`);
  return JSON.parse(stdout);
}

async function withClient<T>(
  deviceId: string | undefined,
  udid: string | undefined,
  body: (client: SimViewClient) => Promise<T>,
): Promise<T> {
  const client = await SimViewClient.start({ deviceId, udid });
  try {
    return await body(client);
  } finally {
    await client.close();
  }
}

async function withSession<T>(
  deviceId: string | undefined,
  udid: string | undefined,
  body: (session: SimViewSession) => Promise<T>,
): Promise<T> {
  const session = new SimViewSession();
  try {
    await session.open(deviceId ?? udid, { startRelay: false });
    return await body(session);
  } finally {
    await session.close();
  }
}

export async function run(argv = process.argv): Promise<void> {
  const { command, positional, options } = parse(argv);
  const deviceId = stringOption(options, "device-id", false);
  const udid = stringOption(options, "udid", false);
  if (deviceId && udid) throw new Error("Pass either --device-id or --udid, not both");
  switch (command) {
    case "version":
      console.log(SIMVIEW_VERSION);
      break;
    case "devices":
      printJson(
        filterDeviceList(await coreJSON("devices"), options.booted === true),
        options.json === true,
      );
      break;
    case "doctor":
      printJson(await coreJSON("doctor"), options.json === true);
      break;
    case "daemon": {
      const action = positional[0] ?? "status";
      if (positional.length > 1) throw new Error("daemon accepts only one action");
      if (action === "status") {
        if (options.all || deviceId || udid) throw new Error("daemon status accepts only --json");
        const statuses = await daemonStatuses(SimViewClient);
        printJson({ backends: statuses, count: statuses.length }, options.json === true);
        break;
      }
      if (action === "prune") {
        if (options.all || deviceId || udid || options.json) {
          throw new Error("daemon prune accepts no options");
        }
        printJson({ pruned: await pruneDaemons() }, true);
        break;
      }
      if (action === "stop") {
        if (options.json) throw new Error("daemon stop does not accept --json");
        if ([options.all === true, Boolean(deviceId), Boolean(udid)].filter(Boolean).length !== 1) {
          throw new Error("daemon stop requires exactly one of --device-id, --udid, or --all");
        }
        if (
          udid &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(udid)
        ) {
          throw new Error("--udid must be a UUID");
        }
        printJson(
          {
            stopped: await stopDaemons(SimViewClient, {
              deviceId,
              udid,
              all: options.all === true,
            }),
          },
          true,
        );
        break;
      }
      throw new Error(`Unknown daemon action: ${action}`);
    }
    case "preview": {
      const session = new SimViewSession();
      const state = await session.open(deviceId ?? udid, { startRelay: true });
      const browserUrl = session.browserUrl();
      const shouldOpen = options["no-open"] !== true;
      printJson(
        {
          device: state.device,
          ...(shouldOpen ? {} : { browserUrl }),
          note: "Press Ctrl-C to stop SimView.",
        },
        false,
      );
      if (shouldOpen && browserUrl) Bun.spawn(["/usr/bin/open", browserUrl]);
      if (options["print-url"] === true && browserUrl) console.log(browserUrl);
      const stop = async () => {
        await session.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await new Promise<never>(() => {});
      break;
    }
    case "screenshot": {
      const output = stringOption(options, "output", true);
      await withClient(deviceId, udid, async (client) => {
        await client.request("capture.start", selectedDeviceParams(deviceId, udid));
        const bytes = nextFrame(client, FrameKind.PngScreenshot);
        const metadata = await client.request("capture.screenshot", {});
        await writeFile(output, await bytes);
        printJson({ output, ...metadata }, true);
      });
      break;
    }
    case "ax-tree": {
      await withClient(deviceId, udid, async (client) => {
        const snapshot = await client.request("accessibility.snapshot", {
          ...selectedDeviceParams(deviceId, udid),
          scope: scopeOption(options),
        });
        await writeOutput(
          options.json === true ? JSON.stringify(snapshot) : compactAccessibilityTree(snapshot),
        );
      });
      break;
    }
    case "tree":
    case "observe": {
      await withSession(deviceId, udid, async (session) => {
        let screenshot:
          | { output: string; frameId: string; width: number; height: number }
          | undefined;
        if (command === "observe" && typeof options.output === "string") {
          const captured = await session.screenshot();
          await writeFile(options.output, captured.bytes);
          screenshot = {
            output: options.output,
            frameId: captured.frameId,
            width: captured.width,
            height: captured.height,
          };
        }
        const result = await session.elementSnapshot(scopeOption(options));
        await writeOutput(
          options.json === true
            ? JSON.stringify({ ...result, ...(screenshot ? { screenshot } : {}) })
            : formatElementTree(result),
        );
      });
      break;
    }
    case "find": {
      await withClient(deviceId, udid, async (client) => {
        const result = await client.request("accessibility.find", {
          ...selectedDeviceParams(deviceId, udid),
          selector: selectorFromOptions(options),
        });
        printJson(result, options.json === true);
      });
      break;
    }
    case "inspect-point": {
      await withClient(deviceId, udid, async (client) => {
        const result = await client.request("accessibility.elementAtPoint", {
          ...selectedDeviceParams(deviceId, udid),
          x: numberOption(options, "x"),
          y: numberOption(options, "y"),
        });
        printJson(result, options.json === true);
      });
      break;
    }
    case "tap-element": {
      await withClient(deviceId, udid, async (client) => {
        const selector = selectorFromOptions(options);
        const result = await client.request("accessibility.find", {
          ...selectedDeviceParams(deviceId, udid),
          selector,
        });
        const index = integerOption(options, "index", 0);
        if (result.count !== 1 && options.index === undefined) {
          throw new Error(`Selector matched ${result.count} elements; refine it or pass --index`);
        }
        const match = result.matches[index];
        const frame = match?.frame?.normalized;
        if (!match || !frame || match.enabled === false) {
          throw new Error("Selected element is unavailable, disabled, or has no visible frame");
        }
        const point = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
        const receipt = await client.request("input.tap", point);
        printJson({ selector, element: match, point, receipt }, true);
      });
      break;
    }
    case "wait": {
      const timeoutMs = integerOption(options, "timeout-ms", 5_000);
      const state = options.state === "hidden" ? "hidden" : "visible";
      await withClient(deviceId, udid, async (client) => {
        const started = performance.now();
        const result = await client.request("accessibility.wait", {
          ...selectedDeviceParams(deviceId, udid),
          selector: selectorFromOptions(options),
          state,
          timeoutMs,
        });
        printJson({ ...result, durationMs: performance.now() - started }, true);
      });
      break;
    }
    case "probe": {
      const action = positional[0] ?? "status";
      if (!["status", "target", "enable", "disable", "context"].includes(action)) {
        throw new Error(`Unknown probe action: ${action}`);
      }
      await withClient(deviceId, udid, async (client) => {
        let result: Record<string, unknown>;
        switch (action) {
          case "enable":
            result = await client.request("probe.enable", {
              ...selectedDeviceParams(deviceId, udid),
              bundleId: stringOption(options, "bundle-id", true),
            });
            break;
          case "disable":
            result = await client.request("probe.disable", selectedDeviceParams(deviceId, udid));
            break;
          case "context":
            result = await client.request("probe.context", {});
            break;
          case "target":
            result = await client.request("probe.target", selectedDeviceParams(deviceId, udid));
            break;
          default:
            result = await client.request("probe.status", {});
        }
        printJson(result, options.json === true);
      });
      break;
    }
    case "tap":
      await withClient(deviceId, udid, (client) =>
        client.request("input.tap", {
          x: numberOption(options, "x"),
          y: numberOption(options, "y"),
        }),
      );
      break;
    case "swipe":
      await withClient(deviceId, udid, (client) =>
        client.request("input.swipe", {
          from: pairOption(options, "from"),
          to: pairOption(options, "to"),
          durationMs: integerOption(options, "duration-ms", 350),
        }),
      );
      break;
    case "type":
      await withClient(deviceId, udid, (client) =>
        client.request("input.typeText", {
          text: positional.join(" "),
        }),
      );
      break;
    case "button": {
      const button = positional[0];
      if (
        button !== "home" &&
        button !== "back" &&
        button !== "overview" &&
        button !== "lock" &&
        button !== "volume-up" &&
        button !== "volume-down" &&
        button !== "action"
      ) {
        throw new Error(
          "button must be home, back, overview, lock, volume-up, volume-down, or action",
        );
      }
      await withClient(deviceId, udid, (client) => client.request("input.button", { button }));
      break;
    }
    case "serve": {
      const child = Bun.spawn([resolveBinary(), "serve", ...positional], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      process.exit(await child.exited);
      return;
    }
    case "mcp":
      await runServer();
      break;
    default:
      console.log(helpText());
  }
}

function nextFrame(client: SimViewClient, kind: FrameKind): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for frame kind ${kind}`));
    }, 5_000);
    const unsubscribe = client.on(kind, (payload) => {
      clearTimeout(timeout);
      unsubscribe();
      resolve(payload);
    });
  });
}

function selectorFromOptions(options: Options) {
  return accessibilitySelectorSchema.parse({
    identifier: stringOption(options, "id", false),
    role: stringOption(options, "role", false),
    name: stringOption(options, "name", false),
    value: stringOption(options, "value", false),
    exact: options.contains !== true,
    index: options.index === undefined ? undefined : integerOption(options, "index", 0),
  });
}

function selectedDeviceParams(
  deviceId: string | undefined,
  udid: string | undefined,
): { deviceId?: string | undefined; udid?: string | undefined } {
  return { ...(deviceId ? { deviceId } : {}), ...(udid ? { udid } : {}) };
}

function scopeOption(options: Options): "interactive" | "visible" | "full" {
  const scope = options.scope ?? "interactive";
  if (scope !== "interactive" && scope !== "visible" && scope !== "full") {
    throw new Error("--scope must be interactive, visible, or full");
  }
  return scope;
}

function stringOption(options: Options, name: string, required: true): string;
function stringOption(options: Options, name: string, required: false): string | undefined;
function stringOption(options: Options, name: string, required: boolean): string | undefined {
  const value = options[name];
  if (typeof value === "string" && value.length > 0) return value;
  if (required) throw new Error(`--${name} is required`);
  return undefined;
}

function numberOption(options: Options, name: string): number {
  const value = Number(options[name]);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
  return value;
}

function integerOption(options: Options, name: string, fallback: number): number {
  if (options[name] === undefined) return fallback;
  const value = Number(options[name]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return value;
}

function pairOption(options: Options, name: string): { x: number; y: number } {
  const [x, y] = String(options[name] ?? "")
    .split(",")
    .map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`--${name} must be x,y`);
  if (x === undefined || y === undefined) throw new Error(`--${name} must be x,y`);
  return { x, y };
}

function printJson(value: unknown, compact: boolean): void {
  console.log(JSON.stringify(value, null, compact ? 0 : 2));
}

async function writeOutput(value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${value}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function formatElementTree(result: ElementTreeOutput): string {
  const context = result.screenContext;
  const summary =
    context.kind === "react-native"
      ? [
          `source=react-native-fiber renderer=${context.renderer}`,
          context.navigationPath?.length
            ? `screen=${context.navigationPath.join(" > ")}`
            : context.route
              ? `screen=${context.route}`
              : undefined,
          context.screenComponent ? `component=${context.screenComponent}` : undefined,
        ]
          .filter(Boolean)
          .join(" ")
      : `context=${context.kind} elements=${result.snapshot.source}${result.fallback ? ` fallback=${result.fallback.reason}${result.fallback.detail ? ` detail=${result.fallback.detail}` : ""}` : ""}`;
  return `${summary}\n${compactAccessibilityTree(result.snapshot)}`;
}

export function filterDeviceList(value: unknown, bootedOnly: boolean): DeviceDescription[] {
  if (!Array.isArray(value)) throw new Error("Device discovery returned an invalid response");
  const devices = value.map(parseDeviceDescription);
  if (!bootedOnly) return devices;
  return devices.filter(
    (device) =>
      device.available &&
      device.state === "ready" &&
      (device.kind === "simulator" || device.kind === "emulator"),
  );
}

function helpText(): string {
  return `SimView ${SIMVIEW_VERSION}

Usage:
  simview --version
  simview devices [--booted] [--json]
  simview doctor --json
  simview preview [--device-id <id>] [--no-open] [--print-url]
  simview screenshot --output <path> [--device-id <id>]
  simview observe [--scope interactive|visible|full] [--output <png>] [--json]
  simview tree [--scope interactive|visible|full] [--json]
  simview ax-tree [--scope interactive|visible|full] [--json]
  simview find [--id <identifier>] [--role <role>] [--name <name>]
  simview inspect-point --x <0..1> --y <0..1>
  simview tap-element [--id <identifier>] [--role <role>] [--name <name>]
  simview wait [selector] --state visible|hidden --timeout-ms <ms>
  simview probe status|target|enable|disable|context [--bundle-id <id>] (iOS only)
  simview tap --x <0..1> --y <0..1>
  simview swipe --from <x,y> --to <x,y> --duration-ms <ms>
  simview type <text>
  simview button <home|back|overview|lock|volume-up|volume-down|action>
  simview daemon status [--json]
  simview daemon stop --device-id <id>
  simview daemon stop --all
  simview daemon prune
  simview mcp
  simview serve --socket <path> --token-fd <fd>

All device commands accept --device-id. --udid remains an iOS compatibility alias.`;
}

if (import.meta.main) {
  run().catch((error) => {
    console.error(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
    );
    process.exit(1);
  });
}
