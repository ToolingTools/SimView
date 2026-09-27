import type { ProcessOwner } from "@simview/contracts";

export type ProcessIdentity = { pid: number; ppid: number; startedAt: string; executable: string };

export function parseProcessSnapshot(text: string): Map<number, ProcessIdentity> {
  const result = new Map<number, ProcessIdentity>();
  for (const line of text.trim().split("\n")) {
    const fields = line.trim().split(/\s+/);
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || fields.length < 8) continue;
    result.set(pid, {
      pid,
      ppid,
      startedAt: fields.slice(2, 7).join(" "),
      executable: fields.slice(7).join(" "),
    });
  }
  return result;
}

export async function processSnapshot(pids?: number[]): Promise<Map<number, ProcessIdentity>> {
  const child = Bun.spawn(
    ["/bin/ps", ...(pids ? ["-p", pids.join(",")] : ["-ax"]), "-o", "pid=,ppid=,lstart=,comm="],
    {
      env: { ...process.env, LC_ALL: "C", LC_TIME: "C" },
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill(9);
  }, 1_000);
  try {
    const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (timedOut)
      throw Object.assign(new Error("MCP process inspection timed out"), { code: "ETIMEDOUT" });
    if (status !== 0 && !(status === 1 && pids))
      throw new Error("Unable to inspect MCP process ownership");
    return parseProcessSnapshot(output);
  } finally {
    clearTimeout(timeout);
  }
}

export function selectProcessOwners(
  snapshot: Map<number, ProcessIdentity>,
  parentPID: number,
): ProcessOwner[] {
  const owners: ProcessOwner[] = [];
  const visited = new Set<number>();
  let pid = parentPID;
  while (pid > 1 && !visited.has(pid) && visited.size < 64) {
    visited.add(pid);
    const current = snapshot.get(pid);
    if (!current) break;
    const application = /\.app\/Contents\/MacOS\//.test(current.executable);
    if (pid === parentPID || application) {
      owners.push({
        pid,
        startedAt: current.startedAt,
        kind: application ? "application" : "agent",
      });
    }
    pid = current.ppid;
  }
  return owners;
}

export function ownersAlive(
  owners: ProcessOwner[],
  snapshot: Map<number, ProcessIdentity>,
): boolean {
  return (
    owners.length > 0 &&
    owners.every((owner) => snapshot.get(owner.pid)?.startedAt === owner.startedAt)
  );
}

export type OwnerExitReason = "owner_exited" | "owner_identity_changed";
export type OwnerInspectionEvent = "owner_inspection_failed" | "owner_inspection_recovered";

export type ProcessOwnerMonitorOptions = {
  snapshot?: typeof processSnapshot;
  probe?: (pid: number) => void;
  schedule?: (check: () => Promise<void>) => () => void;
  onDiagnostic?: (event: OwnerInspectionEvent, error?: unknown) => void;
};

export type ProcessOwnerSubscription = (
  owners: ProcessOwner[],
  onExit: (reason: OwnerExitReason) => void,
) => () => void;

/**
 * Watches a set of process owners with one timer and one ps invocation per tick.
 * Each subscriber still gets independent identity handling while inspection
 * diagnostics are emitted once per monitor transition.
 */
export function createProcessOwnerMonitor({
  snapshot = processSnapshot,
  probe = (pid: number) => {
    process.kill(pid, 0);
  },
  schedule = scheduleOwnerCheck,
  onDiagnostic,
}: ProcessOwnerMonitorOptions = {}): {
  subscribe: ProcessOwnerSubscription;
  dispose: () => void;
} {
  type Subscription = {
    owners: ProcessOwner[];
    onExit: (reason: OwnerExitReason) => void;
    stopped: boolean;
  };
  const subscriptions = new Set<Subscription>();
  let cancelSchedule: (() => void) | undefined;
  let checking = false;
  let disposed = false;
  let inspectionFailed = false;

  const stopSchedule = () => {
    cancelSchedule?.();
    cancelSchedule = undefined;
  };
  const unsubscribe = (subscription: Subscription) => {
    if (subscription.stopped) return;
    subscription.stopped = true;
    subscriptions.delete(subscription);
    if (subscriptions.size === 0) {
      stopSchedule();
      inspectionFailed = false;
    }
  };
  const exit = (subscription: Subscription, reason: OwnerExitReason) => {
    if (subscription.stopped || disposed) return;
    unsubscribe(subscription);
    subscription.onExit(reason);
  };
  const check = async () => {
    if (checking || disposed || subscriptions.size === 0) return;
    checking = true;
    const currentSubscriptions = [...subscriptions];
    const pids = [
      ...new Set(currentSubscriptions.flatMap(({ owners }) => owners.map(({ pid }) => pid))),
    ];
    try {
      let current: Map<number, ProcessIdentity>;
      try {
        current = await snapshot(pids);
      } catch (error) {
        if (disposed) return;
        if (!inspectionFailed) onDiagnostic?.("owner_inspection_failed", error);
        inspectionFailed = true;
        const missing = new Set<number>();
        for (const pid of pids) {
          try {
            probe(pid);
          } catch (probeError) {
            if ((probeError as NodeJS.ErrnoException)?.code === "ESRCH") missing.add(pid);
          }
        }
        for (const subscription of currentSubscriptions) {
          if (subscription.stopped) continue;
          // An unavailable ps result is not evidence of owner death. Only ESRCH
          // from signal zero proves that one of the recorded owners exited.
          if (subscription.owners.some(({ pid }) => missing.has(pid)))
            exit(subscription, "owner_exited");
        }
        return;
      }
      if (disposed) return;
      if (inspectionFailed) onDiagnostic?.("owner_inspection_recovered");
      inspectionFailed = false;
      for (const subscription of currentSubscriptions) {
        if (subscription.stopped) continue;
        if (!ownersAlive(subscription.owners, current)) {
          exit(
            subscription,
            subscription.owners.some((owner) => !current.has(owner.pid)) ||
              subscription.owners.length === 0
              ? "owner_exited"
              : "owner_identity_changed",
          );
        }
      }
    } finally {
      checking = false;
    }
  };
  const subscribe = (owners: ProcessOwner[], onExit: (reason: OwnerExitReason) => void) => {
    if (disposed) return () => {};
    const subscription: Subscription = {
      owners: [...owners],
      onExit,
      stopped: false,
    };
    subscriptions.add(subscription);
    if (!cancelSchedule) cancelSchedule = schedule(check);
    return () => unsubscribe(subscription);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopSchedule();
    for (const subscription of subscriptions) subscription.stopped = true;
    subscriptions.clear();
  };
  return { subscribe, dispose };
}

function scheduleOwnerCheck(check: () => Promise<void>): () => void {
  const timer = setInterval(() => void check(), 1_000);
  timer.unref();
  return () => clearInterval(timer);
}

export function watchProcessOwners(
  owners: ProcessOwner[],
  onExit: (reason: OwnerExitReason) => void,
  options: ProcessOwnerMonitorOptions = {},
): () => void {
  const monitor = createProcessOwnerMonitor(options);
  const stop = monitor.subscribe(owners, onExit);
  return () => {
    stop();
    monitor.dispose();
  };
}
