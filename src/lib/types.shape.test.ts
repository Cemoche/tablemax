import { expect, test } from "vitest";
import type {
  CellValue,
  ConnectionConfig,
  ExecEvent,
  ResultSet,
  RowCount,
  WorkspaceInfo,
} from "./types";

// Literal fixtures copied from the Rust serde tests (value.rs, manager.rs).
test("CellValue fixtures", () => {
  const cells: CellValue[] = [
    JSON.parse('{"t":"null"}'),
    JSON.parse('{"t":"bigInt","v":"18446744073709551615"}'),
    JSON.parse('{"t":"longText","v":{"preview":"é","len":10005}}'),
    JSON.parse('{"t":"bytes","v":{"len":3,"hexPreview":"dead00"}}'),
  ];
  const label = (c: CellValue) => (c.t === "bytes" ? c.v.hexPreview : c.t);
  expect(cells.map(label)).toEqual(["null", "bigInt", "longText", "dead00"]);
});

test("ExecEvent fixtures", () => {
  const events: ExecEvent[] = [
    { event: "statementStarted", data: { index: 2 } },
    { event: "batchFinished", data: { cancelled: true } },
    { event: "statementFailed", data: { index: 0, error: { kind: "cancelled", message: "query cancelled" } } },
    { event: "statementFinished", data: { index: 1, outcome: { result: null, rowsAffected: 3, elapsedMs: 4 } } },
  ];
  const f = events[3];
  if (f.event === "statementFinished") expect(f.data.outcome.rowsAffected).toBe(3);
  expect(events[2].event).toBe("statementFailed");
});

test("WorkspaceInfo, RowCount and ConnectionConfig fixtures", () => {
  const info: WorkspaceInfo = JSON.parse(
    '{"workspaceId":"w","connectionId":"c","dialect":"sqlite","serverVersion":"3"}',
  );
  expect(info.dialect).toBe("sqlite");
  const n: RowCount = { t: "estimate", v: 5 };
  expect(n.t).toBe("estimate");
  const c: ConnectionConfig = {
    id: "",
    name: "n",
    color: "swatch-2",
    envTag: "prod",
    kind: "mariaDb",
    host: "h",
    port: 3306,
    user: "u",
    database: null,
    sqlitePath: null,
    passwordMode: "none",
    group: null,
  };
  expect(Object.keys(c)).toContain("envTag");
});

test("ResultSet carries the truncated flag", () => {
  const r: ResultSet = JSON.parse(
    '{"columns":[{"name":"g","typeName":"int8"}],"rows":[[{"t":"int","v":1}]],"truncated":true}',
  );
  expect(r.truncated).toBe(true);
});
