import { describe, expect, test } from "bun:test";
import type { ProcessOwner } from "@simview/contracts";
import {
  createProcessOwnerMonitor,
  type OwnerExitReason,
  type OwnerInspectionEvent,
  type ProcessIdentity,
  watchProcessOwners,
} from "../packages/client/src/process-owner";

const owners: ProcessOwner[] = [{ pid: 42, startedAt: "original", kind: "agent" }];
const alive = () =>
  new Map<number, ProcessIdentity>([
    [42, { pid: 42, ppid: 1, startedAt: "original", executable: "host" }],
  ]);
function harness() {
  let inspect: () => Promise<Map<number, ProcessIdentity>> = async () => alive();
  let probe: (pid: number) => void = () => {};
  let tick!: () => Promise<void>;
  let inspections = 0;
  let cancellations = 0;
  const exits: OwnerExitReason[] = [];
  const events: OwnerInspectionEvent[] = [];
  const stop = watchProcessOwners(owners, (reason) => exits.push(reason), {
    snapshot: () => {
      inspections += 1;
      return inspect();
    },
    probe: (pid) => probe(pid),
    schedule: (check) => {
      tick = check;
      return () => {
        cancellations += 1;
      };
    },
    onDiagnostic: (event) => events.push(event),
  });
  return {
    tick: () => tick(),
    stop,
    exits,
    events,
    setInspect: (value: typeof inspect) => {
      inspect = value;
    },
    setProbe: (value: typeof probe) => {
      probe = value;
    },
    counts: () => ({ inspections, cancellations }),
  };
}
const failed = async (): Promise<Map<number, ProcessIdentity>> => {
  throw new Error("ps unavailable");
};

function monitorHarness() {
  let inspect: (pids: number[]) => Promise<Map<number, ProcessIdentity>> = async () =>
    new Map([
      [41, { pid: 41, ppid: 1, startedAt: "first", executable: "host" }],
      [42, { pid: 42, ppid: 1, startedAt: "second", executable: "host" }],
    ]);
  let tick!: () => Promise<void>;
  let inspections = 0;
  const requestedPids: number[][] = [];
  let cancellations = 0;
  const exits: OwnerExitReason[] = [];
  const monitor = createProcessOwnerMonitor({
    snapshot: async (pids) => {
      inspections += 1;
      requestedPids.push([...(pids ?? [])]);
      return inspect(pids ?? []);
    },
    schedule: (check) => {
      tick = check;
      return () => {
        cancellations += 1;
      };
    },
  });
  return {
    monitor,
    tick: () => tick(),
    setInspect: (value: typeof inspect) => {
      inspect = value;
    },
    exits,
    counts: () => ({ inspections, requestedPids, cancellations }),
  };
}

describe("process owner watchdog", () => {
  test("survives one or repeated failed checks and resumes identity verification", async () => {
    const h = harness();
    h.setInspect(failed);
    for (let i = 0; i < 4; i += 1) await h.tick();
    expect(h.exits).toEqual([]);
    expect(h.events).toEqual(["owner_inspection_failed"]);
    h.setInspect(async () => alive());
    await h.tick();
    expect(h.events).toEqual(["owner_inspection_failed", "owner_inspection_recovered"]);
    h.setInspect(
      async () => new Map([[42, { pid: 42, ppid: 1, executable: "host", startedAt: "reused" }]]),
    );
    await h.tick();
    await h.tick();
    expect(h.exits).toEqual(["owner_identity_changed"]);
    expect(h.counts().cancellations).toBe(1);
  });
  for (const code of ["EPERM", "EACCES", "EIO"]) {
    test(`treats ${code} from signal zero as inconclusive`, async () => {
      const h = harness();
      h.setInspect(failed);
      h.setProbe(() => {
        throw Object.assign(new Error("probe failed"), { code });
      });
      await h.tick();
      expect(h.exits).toEqual([]);
      h.stop();
    });
  }
  test("closes once when signal zero confirms ESRCH", async () => {
    const h = harness();
    h.setInspect(failed);
    h.setProbe((pid) => {
      expect(pid).toBe(42);
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    await h.tick();
    await h.tick();
    expect(h.exits).toEqual(["owner_exited"]);
    expect(h.counts().inspections).toBe(1);
  });
  test("closes on owner absence in a successful snapshot", async () => {
    const h = harness();
    h.setInspect(async () => new Map());
    await h.tick();
    expect(h.exits).toEqual(["owner_exited"]);
  });
  for (const reject of [false, true]) {
    test(`ignores a ${reject ? "failed" : "successful"} check completing after disposal`, async () => {
      const h = harness();
      const pending = Promise.withResolvers<Map<number, ProcessIdentity>>();
      h.setInspect(() => pending.promise);
      const first = h.tick();
      await h.tick();
      expect(h.counts().inspections).toBe(1);
      h.stop();
      if (reject) pending.reject(new Error("late failure"));
      else pending.resolve(new Map());
      await first;
      expect(h.exits).toEqual([]);
      expect(h.events).toEqual([]);
    });
  }
  test("clears the in-flight guard after a delayed check", async () => {
    const h = harness();
    const pending = Promise.withResolvers<Map<number, ProcessIdentity>>();
    h.setInspect(() => pending.promise);
    const first = h.tick();
    await h.tick();
    pending.resolve(alive());
    await first;
    await h.tick();
    expect(h.counts().inspections).toBe(2);
    h.stop();
  });

  test("takes one deduplicated snapshot for many subscriptions", async () => {
    const h = monitorHarness();
    const owners = [
      { pid: 41, startedAt: "first", kind: "agent" as const },
      { pid: 42, startedAt: "second", kind: "agent" as const },
    ];
    for (let i = 0; i < 25; i += 1) {
      const owner = owners[i % 2];
      if (!owner) throw new Error("missing test owner");
      h.monitor.subscribe([owner], (reason) => h.exits.push(reason));
    }
    await h.tick();
    await h.tick();
    expect(h.counts().inspections).toBe(2);
    expect(h.counts().requestedPids).toEqual([
      [41, 42],
      [41, 42],
    ]);
    h.monitor.dispose();
    expect(h.counts().cancellations).toBe(1);
  });

  test("closes only the subscription whose owner is absent", async () => {
    const h = monitorHarness();
    const secondExits: OwnerExitReason[] = [];
    const first = h.monitor.subscribe([{ pid: 41, startedAt: "first", kind: "agent" }], (reason) =>
      h.exits.push(reason),
    );
    h.monitor.subscribe([{ pid: 42, startedAt: "second", kind: "agent" }], (reason) =>
      secondExits.push(reason),
    );
    h.setInspect(
      async () => new Map([[41, { pid: 41, ppid: 1, startedAt: "first", executable: "host" }]]),
    );
    await h.tick();
    expect(h.exits).toEqual([]);
    expect(secondExits).toEqual(["owner_exited"]);
    first();
    h.monitor.dispose();
  });

  test("does not act on a subscription removed during an in-flight snapshot", async () => {
    const h = monitorHarness();
    const pending = Promise.withResolvers<Map<number, ProcessIdentity>>();
    h.setInspect(() => pending.promise);
    const exits: OwnerExitReason[] = [];
    const stop = h.monitor.subscribe([{ pid: 41, startedAt: "first", kind: "agent" }], (reason) =>
      exits.push(reason),
    );
    const first = h.tick();
    await h.tick();
    stop();
    pending.resolve(new Map());
    await first;
    expect(exits).toEqual([]);
    h.monitor.dispose();
  });

  test("does not emit callbacks after monitor disposal", async () => {
    const h = monitorHarness();
    const pending = Promise.withResolvers<Map<number, ProcessIdentity>>();
    h.setInspect(() => pending.promise);
    const exits: OwnerExitReason[] = [];
    const events: OwnerInspectionEvent[] = [];
    const monitor = createProcessOwnerMonitor({
      snapshot: () => pending.promise,
      schedule: (check) => {
        tick = check;
        return () => {};
      },
      onDiagnostic: (event) => events.push(event),
    });
    let tick!: () => Promise<void>;
    monitor.subscribe([{ pid: 41, startedAt: "first", kind: "agent" }], (reason) =>
      exits.push(reason),
    );
    const first = tick();
    monitor.dispose();
    pending.reject(new Error("late failure"));
    await first;
    expect(exits).toEqual([]);
    expect(events).toEqual([]);
    h.monitor.dispose();
  });
});
