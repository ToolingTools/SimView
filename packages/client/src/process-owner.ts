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

export function watchProcessOwners(owners: ProcessOwner[], onExit: () => void): () => void {
  let stopped = false;
  let checking = false;
  const timer = setInterval(async () => {
    if (checking || stopped) return;
    checking = true;
    try {
      const snapshot = await processSnapshot(owners.map((owner) => owner.pid));
      if (!stopped && !ownersAlive(owners, snapshot)) onExit();
    } catch {
      if (!stopped) onExit();
    } finally {
      checking = false;
    }
  }, 1_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
