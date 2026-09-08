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
  const timeout = setTimeout(() => child.kill(9), 1_000);
  try {
    const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
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

function scheduleOwnerCheck(check: () => Promise<void>): () => void {
  const timer = setInterval(() => void check(), 1_000);
  timer.unref();
  return () => clearInterval(timer);
}

export function watchProcessOwners(
  owners: ProcessOwner[],
  onExit: (reason: OwnerExitReason) => void,
  {
    snapshot = processSnapshot,
    probe = (pid: number) => {
      process.kill(pid, 0);
    },
    schedule = scheduleOwnerCheck,
    onDiagnostic,
  }: {
    snapshot?: typeof processSnapshot;
    probe?: (pid: number) => void;
    schedule?: (check: () => Promise<void>) => () => void;
    onDiagnostic?: (event: OwnerInspectionEvent, error?: unknown) => void;
  } = {},
): () => void {
  let stopped = false;
  let checking = false;
  let inspectionFailed = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancel();
  };
  const exit = (reason: OwnerExitReason) => {
    if (stopped) return;
    stop();
    onExit(reason);
  };
  const cancel = schedule(async () => {
    if (checking || stopped) return;
    checking = true;
    try {
      let current: Map<number, ProcessIdentity>;
      try {
        current = await snapshot(owners.map((owner) => owner.pid));
      } catch (error) {
        if (stopped) return;
        if (!inspectionFailed) onDiagnostic?.("owner_inspection_failed", error);
        inspectionFailed = true;
        // An unavailable ps result is not evidence of owner death. EPERM and
        // other probe failures are also inconclusive; only ESRCH proves exit.
        for (const owner of owners) {
          try {
            probe(owner.pid);
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === "ESRCH") {
              exit("owner_exited");
              return;
            }
          }
        }
        return;
      }
      if (stopped) return;
      if (inspectionFailed) onDiagnostic?.("owner_inspection_recovered");
      inspectionFailed = false;
      if (!ownersAlive(owners, current)) {
        exit(
          owners.some((owner) => !current.has(owner.pid)) || owners.length === 0
            ? "owner_exited"
            : "owner_identity_changed",
        );
      }
    } finally {
      checking = false;
    }
  });
  return stop;
}
