#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";
import { resolveBinary } from "@simview/core";
import {
  compactAccessibilityTree,
  FrameKind,
  SimViewClient,
  type AccessibilityNode,
  type AccessibilitySnapshot,
} from "@simview/client";
import { SimViewSession } from "@simview/mcp";

type Options = Record<string, string | boolean>;

function parse(argv: string[]) {
  const command = argv[2] ?? "help";
  const positional: string[] = [];
  const options: Options = {};
  for (let index = 3; index < argv.length; index++) {
    const value = argv[index]!;
    if (!value.startsWith("--")) {
      positional.push(value);
    } else if (argv[index + 1] && !argv[index + 1]!.startsWith("--")) {
      options[value.slice(2)] = argv[++index]!;
    } else {
      options[value.slice(2)] = true;
    }
  }
  return { command, positional, options };
}

async function coreJSON(command: "doctor" | "devices"): Promise<unknown> {
  const process = Bun.spawn([resolveBinary(), command], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (status !== 0) throw new Error(stderr.trim() || `${command} failed`);
  return JSON.parse(stdout);
}

async function withClient<T>(udid: string | undefined, body: (client: SimViewClient) => Promise<T>) {
  const client = await SimViewClient.start({ udid });
  try {
    return await body(client);
  } finally {
    await client.close();
  }
}

export async function run(argv = process.argv): Promise<void> {
  const { command, positional, options } = parse(argv);
  const udid = typeof options.udid === "string" ? options.udid : undefined;
  switch (command) {
  case "devices":
    console.log(JSON.stringify(await coreJSON("devices"), null, options.json ? 0 : 2));
    break;
  case "doctor":
    console.log(JSON.stringify(await coreJSON("doctor"), null, options.json ? 0 : 2));
    break;
  case "preview": {
    const session = new SimViewSession();
    const state = await session.open(udid);
    console.log(JSON.stringify({
      browserUrl: state.browserUrl,
      device: state.device,
      note: "Press Ctrl-C to stop SimView.",
    }, null, 2));
    if (!options["no-open"] && state.browserUrl) Bun.spawn(["/usr/bin/open", state.browserUrl]);
    const stop = async () => {
      await session.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await new Promise(() => {});
    break;
  }
  case "screenshot": {
    if (typeof options.output !== "string") throw new Error("--output is required");
    await withClient(udid, async client => {
      await client.request("capture.start", { udid });
      const bytes = new Promise<Uint8Array>(resolve => {
        const unsubscribe = client.on(FrameKind.PngScreenshot, payload => {
          unsubscribe();
          resolve(payload);
        });
      });
      const metadata = await client.request("capture.screenshot");
      await writeFile(options.output as string, await bytes);
      console.log(JSON.stringify({ output: options.output, ...metadata as object }));
    });
    break;
  }
  case "tree":
  case "observe": {
    await withClient(udid, async client => {
      const snapshot = await client.request<AccessibilitySnapshot>("accessibility.snapshot", {
        udid,
        scope: typeof options.scope === "string" ? options.scope : "interactive",
      });
      if (command === "observe" && typeof options.output === "string") {
        await client.request("capture.start", { udid });
        const bytes = new Promise<Uint8Array>(resolve => {
          const unsubscribe = client.on(FrameKind.PngScreenshot, payload => {
            unsubscribe();
            resolve(payload);
          });
        });
        await client.request("capture.screenshot");
        await writeFile(options.output, await bytes);
      }
      console.log(options.json
        ? JSON.stringify(snapshot)
        : compactAccessibilityTree(snapshot));
    });
    break;
  }
  case "find": {
    await withClient(udid, async client => {
      const result = await client.request("accessibility.find", {
        udid,
        selector: selectorFromOptions(options),
      });
      console.log(JSON.stringify(result, null, options.json ? 0 : 2));
    });
    break;
  }
  case "inspect-point": {
    await withClient(udid, async client => {
      const result = await client.request("accessibility.elementAtPoint", {
        udid,
        x: numberOption(options, "x"),
        y: numberOption(options, "y"),
      });
      console.log(JSON.stringify(result, null, options.json ? 0 : 2));
    });
    break;
  }
  case "tap-element": {
    await withClient(udid, async client => {
      const result = await client.request<{ matches: AccessibilityNode[]; count: number }>(
        "accessibility.find",
        { udid, selector: selectorFromOptions(options) },
      );
      const index = typeof options.index === "string" ? Number(options.index) : 0;
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
      console.log(JSON.stringify({ selector: selectorFromOptions(options), element: match, point, receipt }));
    });
    break;
  }
  case "wait": {
    const timeout = typeof options.timeout === "string" ? Number(options.timeout) : 5_000;
    const desired = typeof options.state === "string" ? options.state : "visible";
    await withClient(udid, async client => {
      const started = performance.now();
      let count = 0;
      do {
        const result = await client.request<{ count: number }>("accessibility.find", {
          udid,
          selector: selectorFromOptions(options),
        });
        count = result.count;
        if ((desired === "hidden" && count === 0) || (desired !== "hidden" && count > 0)) {
          console.log(JSON.stringify({ state: desired, matched: count, durationMs: performance.now() - started }));
          return;
        }
        await Bun.sleep(200);
      } while (performance.now() - started < timeout);
      throw new Error(`Timed out after ${timeout}ms waiting for element to be ${desired}; last count ${count}`);
    });
    break;
  }
  case "probe": {
    const action = positional[0] ?? "status";
    await withClient(udid, async client => {
      let result: unknown;
      if (action === "enable") {
        if (typeof options["bundle-id"] !== "string") throw new Error("--bundle-id is required");
        result = await client.request("probe.enable", {
          udid,
          bundleId: options["bundle-id"],
        });
      } else if (action === "disable") {
        result = await client.request("probe.disable", { udid });
      } else if (action === "context") {
        result = await client.request("probe.context");
      } else {
        result = await client.request("probe.status");
      }
      console.log(JSON.stringify(result, null, options.json ? 0 : 2));
    });
    break;
  }
  case "tap":
    await withClient(udid, client => client.request("input.tap", {
      x: numberOption(options, "x"),
      y: numberOption(options, "y"),
    }));
    break;
  case "swipe":
    await withClient(udid, client => client.request("input.swipe", {
      from: pairOption(options, "from"),
      to: pairOption(options, "to"),
      durationMs: typeof options.duration === "string" ? Number(options.duration) : 350,
    }));
    break;
  case "type":
    await withClient(udid, client => client.request("input.typeText", {
      text: positional.join(" "),
    }));
    break;
  case "button":
    await withClient(udid, client => client.request("input.button", {
      button: positional[0],
    }));
    break;
  case "serve": {
    const child = Bun.spawn([resolveBinary(), "serve", ...argv.slice(3)], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exit(await child.exited);
  }
  default:
    console.log(`SimView 0.1.0

Usage:
  simview devices --json
  simview doctor --json
  simview preview [--udid <udid>] [--no-open]
  simview screenshot --output <path> [--udid <udid>]
  simview observe [--scope interactive|visible|full] [--output <png>] [--json]
  simview tree [--scope interactive|visible|full] [--json]
  simview find [--id <identifier>] [--role <role>] [--name <name>]
  simview inspect-point --x <0..1> --y <0..1>
  simview tap-element [--id <identifier>] [--role <role>] [--name <name>]
  simview wait [selector] --state visible|hidden --timeout <ms>
  simview probe status|enable|disable|context [--bundle-id <id>]
  simview tap --x <0..1> --y <0..1>
  simview swipe --from <x,y> --to <x,y> --duration <ms>
  simview type <text>
  simview button <home|lock|volume-up|volume-down|action>
  simview serve --socket <path> --token-fd <fd>`);
  }
}

function selectorFromOptions(options: Options) {
  const selector = {
    identifier: typeof options.id === "string" ? options.id : undefined,
    role: typeof options.role === "string" ? options.role : undefined,
    name: typeof options.name === "string" ? options.name : undefined,
    value: typeof options.value === "string" ? options.value : undefined,
    exact: options.contains ? false : true,
  };
  if (!selector.identifier && !selector.role && !selector.name && !selector.value) {
    throw new Error("Pass at least one of --id, --role, --name, or --value");
  }
  return selector;
}

function numberOption(options: Options, name: string): number {
  const value = Number(options[name]);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
  return value;
}

function pairOption(options: Options, name: string): { x: number; y: number } {
  const [x, y] = String(options[name] ?? "").split(",").map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`--${name} must be x,y`);
  return { x: x!, y: y! };
}

if (import.meta.main) {
  run().catch(error => {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  });
}
