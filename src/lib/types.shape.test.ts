import { expect, test } from "vitest";
import type {
  CellValue,
  ConnectionConfig,
  ErrorKind,
  ExecEvent,
  FilePurpose,
  HistoryEntry,
  ImportPreview,
  ImportResult,
  ResultSet,
  SavedQuery,
  RowCount,
  SshAuth,
  SslMode,
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
    ssl: { mode: "verifyFull", caFile: "/ca.pem", certFile: null, keyFile: null },
    ssh: null,
  };
  expect(Object.keys(c)).toContain("envTag");
});

// Literal JSON of ConnectionConfig with SSL and SSH, as store.rs serialises it
// (ssh_settings_serde_shape_is_camel_case).
test("ConnectionConfig with ssl and ssh settings", () => {
  const c: ConnectionConfig = JSON.parse(`{
    "id":"x","name":"n","color":"swatch-1","envTag":"dev","kind":"postgres",
    "host":"pg16","port":5432,"user":"postgres","database":"tablemax_demo","sqlitePath":null,
    "passwordMode":"keyring","group":null,
    "ssl":{"mode":"verifyCa","caFile":"/ca.pem","certFile":"/c.pem","keyFile":"/k.pem"},
    "ssh":{"host":"bastion","port":2222,"user":"tunnel","auth":"key","keyFile":"/id","secretMode":"ask"}
  }`);
  const modes: SslMode[] = ["disable", "prefer", "require", "verifyCa", "verifyFull"];
  const auths: SshAuth[] = ["password", "key", "agent"];
  expect(modes).toContain(c.ssl.mode);
  expect(auths).toContain(c.ssh?.auth);
  expect(c.ssh?.secretMode).toBe("ask");
  expect(c.ssl.keyFile).toBe("/k.pem");
  const purposes: FilePurpose[] = ["caCert", "clientCert", "clientKey", "sshKey", "tableplusExport"];
  expect(purposes).toHaveLength(5);
  const kinds: ErrorKind[] = ["hostKeyUnknown", "hostKeyChanged"];
  expect(kinds).toHaveLength(2);
});

test("ResultSet carries the truncated flag", () => {
  const r: ResultSet = JSON.parse(
    '{"columns":[{"name":"g","typeName":"int8"}],"rows":[[{"t":"int","v":1}]],"truncated":true}',
  );
  expect(r.truncated).toBe(true);
});

// import/mod.rs ImportPreview / ImportResult (camelCase; tests/tableplus_import.rs checks
// "importId" and "hasPassword" on the wire).
test("ImportPreview and ImportResult", () => {
  const p: ImportPreview = JSON.parse(`{
    "importId":"i","warnings":[{"entry":"k","message":"m"}],
    "items":[{"index":0,"hasPassword":true,"hasSshSecret":false,"duplicateOf":null,
      "config":{"id":"","name":"n","color":"swatch-1","envTag":"local","kind":"sqlite",
        "host":"","port":0,"user":"","database":null,"sqlitePath":"/x.db",
        "passwordMode":"none","group":null,
        "ssl":{"mode":"prefer","caFile":null,"certFile":null,"keyFile":null},"ssh":null}}]
  }`);
  expect(p.items[0].hasPassword).toBe(true);
  expect(p.warnings[0].entry).toBe("k");
  const r: ImportResult = JSON.parse('{"saved":[],"warnings":[]}');
  expect(r.saved).toEqual([]);
});

// history.rs HistoryEntry / saved_queries.rs SavedQuery (tests/persistence.rs checks the
// camelCase keys on the Rust side).
test("HistoryEntry and SavedQuery", () => {
  const h: HistoryEntry = JSON.parse(
    '{"id":1,"connectionId":"c","sql":"select 1","executedAt":1760000000000,"elapsedMs":3,"rows":1,"error":null}',
  );
  expect(h.executedAt).toBe(1760000000000);
  expect(h.error).toBeNull();
  const q: SavedQuery = JSON.parse('{"name":"Été","modifiedAt":1760000000000,"size":5}');
  expect(q.modifiedAt).toBe(1760000000000);
});
