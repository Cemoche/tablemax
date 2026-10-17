// Mirrors is_local_host / default_ssl_mode of src-tauri/src/driver/tls.rs.
import type { DriverKind, SslMode } from "./types";

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The four octets of a dotted IPv4 address, or null. */
function ipv4(s: string): number[] | null {
  const m = IPV4.exec(s);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

/** The eight 16-bit groups of an IPv6 address (incl. "::" and a trailing IPv4), or null. */
function ipv6(s: string): number[] | null {
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    const items = part.split(":");
    for (const [i, item] of items.entries()) {
      const v4 = i === items.length - 1 ? ipv4(item) : null;
      if (v4) groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      else if (/^[0-9a-f]{1,4}$/i.test(item)) groups.push(parseInt(item, 16));
      else return null;
    }
    return groups;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const gap = 8 - head.length - tail.length;
  return gap >= 1 ? [...head, ...Array<number>(gap).fill(0), ...tail] : null;
}

/** `localhost`, a loopback IP (127.0.0.0/8 or ::1, bracketed or not) or a socket path. */
export function isLocalHost(host: string): boolean {
  if (host.startsWith("/") || host.toLowerCase() === "localhost") return true;
  const ip = host.replace(/^[[\]]+|[[\]]+$/g, "");
  const v4 = ipv4(ip);
  if (v4) return v4[0] === 127;
  const v6 = ipv6(ip);
  return v6 !== null && v6.slice(0, 7).every((g) => g === 0) && v6[7] === 1;
}

/**
 * The SSL mode a new connection starts with: verifyFull for a remote host reached
 * directly, prefer for a local host or through an SSH tunnel.
 */
export function defaultSslMode(host: string, overSsh: boolean): SslMode {
  return overSsh || isLocalHost(host) ? "prefer" : "verifyFull";
}

const ALL_MODES: SslMode[] = ["disable", "prefer", "require", "verifyCa", "verifyFull"];

/** Modes offered for a driver: MySQL/MariaDB do not support verifyCa yet (mysql_async). */
export function sslModesFor(kind: DriverKind): SslMode[] {
  return kind === "mySql" || kind === "mariaDb" ? ALL_MODES.filter((m) => m !== "verifyCa") : ALL_MODES;
}

/** Disable/prefer to a remote host without a tunnel: traffic may be cleartext or unverified. */
export function isCleartextRisk(host: string, overSsh: boolean, mode: SslMode): boolean {
  return !overSsh && !isLocalHost(host) && (mode === "disable" || mode === "prefer");
}
