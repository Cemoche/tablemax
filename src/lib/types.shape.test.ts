import { expect, test } from "vitest";
import type {
  ApplyOutcome,
  CellValue,
  ConnectionConfig,
  ErrorKind,
  ExecEvent,
  FilePurpose,
  ImportPreview,
  ImportResult,
  EditValue,
  Filter,
  FilterOp,
  PageRequest,
  ResultSet,
  RowChange,
  RowCount,
  SshAuth,
  SslMode,
  TableInfo,
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

// driver/meta.rs TableInfo / ColumnInfo / IndexInfo / ForeignKeyInfo (camelCase).
test("TableInfo", () => {
  const t: TableInfo = JSON.parse(`{
    "object":{"schema":"public","name":"order"},"kind":"table",
    "columns":[{"name":"amount","typeName":"numeric(12,2)","baseType":"numeric","nullable":true,
      "default":"0","autoIncrement":false,"generated":false,"binary":false,"comment":null},
      {"name":"data","typeName":"bytea","baseType":"bytea","nullable":true,"default":null,
      "autoIncrement":false,"generated":false,"binary":true,"comment":null}],
    "primaryKey":["id"],
    "indexes":[{"name":"order_pkey","columns":["id"],"unique":true,"primary":true,"definition":null}],
    "foreignKeys":[{"name":"f","columns":["parent_id"],"refSchema":null,"refTable":"parent",
      "refColumns":["id"],"onUpdate":"NO ACTION","onDelete":"CASCADE"}],
    "rowKey":["id"],"hasRowid":false
  }`);
  expect(t.columns[0].baseType).toBe("numeric");
  expect(t.columns.map((c) => c.binary)).toEqual([false, true]);
  expect(t.foreignKeys[0].onDelete).toBe("CASCADE");
  expect(t.rowKey).toEqual(["id"]);
});

// driver/query.rs Filter / FilterOp and driver/mod.rs PageRequest (query.rs serde_shapes).
test("Filter and PageRequest", () => {
  const ops: FilterOp[] = [
    "eq", "neq", "lt", "gt", "lte", "gte", "in", "notIn", "between", "notBetween",
    "like", "notLike", "ilike", "contains", "notContains", "isNull", "isNotNull", "raw",
  ];
  expect(ops).toHaveLength(18);
  const f: Filter = JSON.parse('{"column":null,"op":"notContains","values":["x"]}');
  expect(f.column).toBeNull();
  const req: PageRequest = {
    object: { schema: null, name: "t" },
    limit: 300,
    offset: 0,
    sort: ["a", "desc"],
    filters: [f],
  };
  expect(Object.keys(req)).toEqual(["object", "limit", "offset", "sort", "filters"]);
});

// driver/dml.rs serde_shapes: EditValue, RowKey pairs, RowChange, ApplyOutcome.
test("EditValue, RowChange and ApplyOutcome", () => {
  const values: EditValue[] = [JSON.parse('{"t":"text","v":"x"}'), JSON.parse('{"t":"default"}'), { t: "null" }];
  expect(values.map((v) => v.t)).toEqual(["text", "default", "null"]);
  const changes: RowChange[] = JSON.parse(`[
    {"kind":"update","key":[["id",{"t":"int","v":7}],["code",{"t":"text","v":"a'b"}]],
     "set":[["amount",{"t":"text","v":"12.30"}],["note",{"t":"null"}]]},
    {"kind":"insert","values":[["id",{"t":"default"}]]},
    {"kind":"delete","key":[["data",{"t":"bytes","v":{"len":1,"hexPreview":"00"}}]]}
  ]`);
  const u = changes[0];
  if (u.kind === "update") expect(u.key[1]).toEqual(["code", { t: "text", v: "a'b" }]);
  expect(changes.map((c) => c.kind)).toEqual(["update", "insert", "delete"]);
  const o: ApplyOutcome = JSON.parse(`{
    "applied":false,"affected":[1,0],"failedIndex":1,
    "error":{"kind":"query","message":"the row was deleted or its key changed since it was loaded"}
  }`);
  expect(o.failedIndex).toBe(1);
  expect(o.error?.kind).toBe("query");
});
