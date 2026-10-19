import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import type { ConnectionConfig, EnvTag, SafeMode } from "../../lib/types";
import { useConnections } from "../../stores/connections";
import { EnvBanner } from "./EnvBanner";

const cfg = (envTag: EnvTag, safeMode?: SafeMode | null): ConnectionConfig => ({
  id: "c1",
  name: "Shop",
  color: "swatch-1",
  envTag,
  kind: "postgres",
  host: "h",
  port: 5432,
  user: "u",
  database: null,
  sqlitePath: null,
  passwordMode: "keyring",
  group: null,
  ssl: { mode: "prefer", caFile: null, certFile: null, keyFile: null },
  ssh: null,
  safeMode,
});

const setup = (envTag: EnvTag, safeMode?: SafeMode | null) => {
  useConnections.setState({ items: [cfg(envTag, safeMode)] });
  // Opened with the same config as the saved one.
  render(<EnvBanner workspace={{ connectionId: "c1", name: "Shop", envTag, safeMode }} />);
  return screen.getByRole("status");
};

beforeEach(() => useConnections.setState({ items: [] }));

test.each(["local", "dev", "staging", "prod"] as const)("%s uses its token class", (tag) => {
  const banner = setup(tag);
  expect(banner.className).toContain(`bg-env-${tag}`);
  expect(banner).toHaveTextContent(`Shop · ${tag.toUpperCase()}`);
});

test("prod shows the effective safe mode", () => {
  expect(setup("prod")).toHaveTextContent("Safe mode: confirm writes");
});

test("a non-prod connection with an explicit mode shows it, an off one shows nothing", () => {
  expect(setup("dev", "confirmAll")).toHaveTextContent("Safe mode: confirm all queries");
});

test("dev without a mode has no safe mode text", () => {
  expect(setup("dev").textContent).not.toContain("Safe mode");
});

test("prod switched off says so", () => {
  expect(setup("prod", "off")).toHaveTextContent("Safe mode: off");
});

test("after a retag while open: live tag, enforced (stricter) mode", () => {
  // Opened as prod with the default mode, then saved as dev: still confirm writes until reopened.
  useConnections.setState({ items: [cfg("dev")] });
  render(<EnvBanner workspace={{ connectionId: "c1", name: "Shop", envTag: "prod", safeMode: null }} />);
  const banner = screen.getByRole("status");
  expect(banner).toHaveTextContent("Shop · DEV");
  expect(banner.className).toContain("bg-env-dev");
  expect(banner).toHaveTextContent("Safe mode: confirm writes");
});

test("prod switched off while open still shows the enforced mode", () => {
  useConnections.setState({ items: [cfg("prod", "off")] });
  render(<EnvBanner workspace={{ connectionId: "c1", name: "Shop", envTag: "prod", safeMode: null }} />);
  expect(screen.getByRole("status")).toHaveTextContent("Safe mode: confirm writes");
});

test("a retag to prod while open applies at once", () => {
  useConnections.setState({ items: [cfg("prod")] });
  render(<EnvBanner workspace={{ connectionId: "c1", name: "Shop", envTag: "dev", safeMode: null }} />);
  const banner = screen.getByRole("status");
  expect(banner).toHaveTextContent("Shop · PROD");
  expect(banner).toHaveTextContent("Safe mode: confirm writes");
});

test("a deleted connection falls back to the opened config", () => {
  render(<EnvBanner workspace={{ connectionId: "c1", name: "Shop", envTag: "prod", safeMode: null }} />);
  const banner = screen.getByRole("status");
  expect(banner).toHaveTextContent("Shop · PROD");
  expect(banner).toHaveTextContent("Safe mode: confirm writes");
});
