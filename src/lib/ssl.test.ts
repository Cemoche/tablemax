import { expect, test } from "vitest";
import { defaultSslMode, isLocalHost } from "./ssl";

// Same cases as default_ssl_mode_verifies_remote_direct_hosts_only (driver/tls.rs).
test("remote hosts reached directly default to verifyFull, over SSH to prefer", () => {
  for (const h of ["db.example.com", "10.0.0.5", "0.0.0.0", "pg16", ""]) {
    expect(defaultSslMode(h, false), h).toBe("verifyFull");
    expect(defaultSslMode(h, true), h).toBe("prefer");
  }
});

test("local hosts default to prefer", () => {
  for (const h of [
    "localhost",
    "LocalHost",
    "127.0.0.1",
    "127.1.2.3",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    "/var/run/postgresql",
  ]) {
    expect(isLocalHost(h), h).toBe(true);
    expect(defaultSslMode(h, false), h).toBe("prefer");
    expect(defaultSslMode(h, true), h).toBe("prefer");
  }
});

test("look-alikes of local hosts are not local", () => {
  for (const h of ["localhost.example.com", "127.0.0.256", "128.0.0.1", "::2", "127.0.0", "my-localhost"]) {
    expect(isLocalHost(h), h).toBe(false);
  }
});
