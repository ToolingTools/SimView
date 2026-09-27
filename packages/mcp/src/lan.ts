import { networkInterfaces } from "node:os";

export interface LanAddress {
  name: string;
  address: string;
}

export function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)
  )
    return false;
  const [a, b] = parts.map(Number);
  return (
    a === 10 || (a === 172 && b !== undefined && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}

export function lanAddresses(): LanAddress[] {
  return Object.entries(networkInterfaces())
    .flatMap(([name, entries]) =>
      (entries ?? [])
        .filter(
          (entry) => entry.family === "IPv4" && !entry.internal && isPrivateIPv4(entry.address),
        )
        .map((entry) => ({ name, address: entry.address })),
    )
    .sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
}

export function selectLanAddress(
  addresses: LanAddress[],
  preferredInterface?: string,
  host?: string,
): string {
  if (host !== undefined) {
    if (!isPrivateIPv4(host) || !addresses.some((entry) => entry.address === host)) {
      throw new Error("LAN host must be an assigned private IPv4 address on this computer.");
    }
    return host;
  }
  const preferred = addresses.filter((entry) => entry.name === preferredInterface);
  const candidates = preferred.length ? preferred : addresses;
  const unique = [...new Set(candidates.map((entry) => entry.address))];
  if (unique.length === 1 && unique[0]) return unique[0];
  if (!addresses.length)
    throw new Error(
      "No private LAN IPv4 address is available. Connect to a local network and retry.",
    );
  throw new Error(
    `Choose a LAN host explicitly: ${addresses.map((entry) => `${entry.name}: ${entry.address}`).join(", ")}`,
  );
}

export function resolveLanAddress(host?: string): string {
  let preferred: string | undefined;
  if (host === undefined && process.platform === "darwin") {
    const route = Bun.spawnSync(["/sbin/route", "-n", "get", "default"], { timeout: 2_000 });
    if (route.exitCode === 0)
      preferred = route.stdout.toString().match(/^\s*interface:\s*(\S+)/m)?.[1];
  }
  return selectLanAddress(lanAddresses(), preferred, host);
}
