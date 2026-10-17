import type { Completion, CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import { MySQL, PostgreSQL, SQLite, keywordCompletionSource } from "@codemirror/lang-sql";
import type { Text } from "@codemirror/state";
import { isReservedWord, quoteIdentIfNeeded } from "../../lib/sqlIdent";
import type { Catalog, CatalogTable, Dialect } from "../../lib/types";
import { type Token, identName, isComment, isPunct, tokenize, wordOf } from "./sqlLexer";

export interface CompletionOptions {
  /**
   * Catalogs of other schemas already loaded (no fetch is made for them): their tables
   * are offered as `schema.table`, and `schema.` lists them.
   */
  otherCatalogs?: Catalog[];
  /** Schema names of the database, offered as completions. */
  schemas?: string[];
  /** Loads a schema typed as `schema.` that is in `schemas` but not loaded yet. */
  loadSchema?: (schema: string) => Promise<Catalog | null>;
}

const LANG = { postgres: PostgreSQL, mySql: MySQL, sqlite: SQLite } as const;

const keywordCache = new Map<Dialect, Completion[]>();
/** The dialect's keywords, types and builtins as lang-sql knows them, upper-cased. */
function dialectKeywords(dialect: Dialect): Completion[] {
  let list = keywordCache.get(dialect);
  if (!list) {
    const out: Completion[] = [];
    // The builder runs once per word, synchronously: harvest the list it is given.
    keywordCompletionSource(LANG[dialect], true, (label, type) => {
      const c = { label, type, boost: -1 };
      out.push(c);
      return c;
    });
    list = out;
    keywordCache.set(dialect, list);
  }
  return list;
}

/** Words that end a table reference instead of naming its alias. */
const NOT_ALIAS = new Set([
  "WHERE", "ON", "USING", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "OUTER",
  "GROUP", "ORDER", "LIMIT", "HAVING", "UNION", "EXCEPT", "INTERSECT", "WINDOW", "SET", "OFFSET",
  "FETCH", "FOR", "RETURNING", "STRAIGHT_JOIN", "LATERAL", "TABLESAMPLE", "VALUES", "SELECT",
  "FROM", "WITH", "LOCK", "INTO", "PARTITION", "FORCE", "IGNORE", "USE", "WHEN", "THEN", "AND", "OR",
]);
/** Keywords followed by a table reference (FROM and USING take comma-separated lists). */
const TABLE_INTRO = new Set(["FROM", "JOIN", "UPDATE", "INTO", "USING"]);

interface Ident {
  name: string;
  quoted: boolean;
}
interface TableRef {
  schema: Ident | null;
  table: Ident;
  alias: Ident | null;
}

/** Does the identifier designate `b`? Quoted: exactly; bare: case-insensitively. */
const sameIdent = (a: Ident, b: string) => (a.quoted ? a.name === b : a.name.toLowerCase() === b.toLowerCase());
const identsMatch = (a: Ident, b: Ident) =>
  a.quoted || b.quoted ? a.name === b.name : a.name.toLowerCase() === b.name.toLowerCase();

/** Finds `name` in `tables`: an exact match first, then (bare names) a case-insensitive one. */
function findTable(tables: CatalogTable[], name: Ident): CatalogTable | null {
  return tables.find((t) => t.name === name.name) ?? (name.quoted ? null : tables.find((t) => sameIdent(name, t.name)) ?? null);
}

/** Table references (with their alias) declared in a statement's tokens. */
function tableRefs(sql: string, toks: Token[], dialect: Dialect): TableRef[] {
  const refs: TableRef[] = [];
  const ident = (t: Token | undefined): Ident | null => {
    if (!t) return null;
    if (t.kind === "qident") return identName(sql, t);
    if (t.kind !== "word") return null;
    const w = wordOf(sql, t);
    return NOT_ALIAS.has(w) || isReservedWord(dialect, w) ? null : identName(sql, t);
  };
  const parseRef = (start: number): number => {
    let j = start;
    if (wordOf(sql, toks[j]) === "ONLY" || wordOf(sql, toks[j]) === "LATERAL") j++;
    if (isPunct(sql, toks[j], "(")) {
      // Derived table: skip it, its columns are unknown.
      let depth = 0;
      for (; j < toks.length; j++) {
        if (isPunct(sql, toks[j], "(")) depth++;
        else if (isPunct(sql, toks[j], ")") && --depth === 0) break;
      }
      j++;
      if (wordOf(sql, toks[j]) === "AS") j++;
      return ident(toks[j]) ? j + 1 : j;
    }
    const parts: Ident[] = [];
    let first = toks[j]?.kind === "qident" ? identName(sql, toks[j]) : toks[j]?.kind === "word" ? identName(sql, toks[j]) : null;
    if (!first) return j;
    parts.push(first);
    j++;
    while (isPunct(sql, toks[j], ".") && (toks[j + 1]?.kind === "word" || toks[j + 1]?.kind === "qident")) {
      first = identName(sql, toks[j + 1]);
      if (first) parts.push(first);
      j += 2;
    }
    if (wordOf(sql, toks[j]) === "AS") j++;
    const alias = ident(toks[j]);
    if (alias) j++;
    refs.push({ table: parts[parts.length - 1], schema: parts.length > 1 ? parts[parts.length - 2] : null, alias });
    return j;
  };
  for (let i = 0; i < toks.length; i++) {
    const w = wordOf(sql, toks[i]);
    if (!TABLE_INTRO.has(w)) continue;
    let j = parseRef(i + 1);
    if (w === "FROM" || w === "USING") {
      while (isPunct(sql, toks[j], ",")) j = parseRef(j + 1);
    }
    i = Math.max(i, j - 1);
  }
  return refs;
}

/** Index of the first token ending at or after `pos`. */
function tokenAt(toks: Token[], pos: number): number {
  let lo = 0;
  let hi = toks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (toks[mid].to < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Schema-aware completion: dialect keywords, tables (other loaded schemas as
 * `schema.table`), and columns after `table.` / `alias.` with the aliases of the current
 * statement resolved. Inserted identifiers are quoted only when the dialect needs it.
 * It replaces lang-sql's own keyword/schema completion.
 */
export function buildCompletionSource(
  catalog: Catalog | null,
  dialect: Dialect,
  options: CompletionOptions = {},
): CompletionSource {
  const current = catalog?.tables ?? [];
  const currentSchema = catalog?.schema ?? null;
  const others = (options.otherCatalogs ?? []).filter((c) => c.schema !== null && c.schema !== currentSchema);
  const loaded = new Map<string, Catalog>(others.map((c) => [c.schema as string, c]));
  if (catalog && currentSchema !== null) loaded.set(currentSchema, catalog);
  const qi = (name: string) => quoteIdentIfNeeded(dialect, name);

  // Memoized per source (one source per catalog set): built on first use.
  const columnCache = new Map<CatalogTable, Completion[]>();
  const columnOptions = (t: CatalogTable): Completion[] => {
    let list = columnCache.get(t);
    if (!list) {
      list = t.columns.map((c) => withApply({ label: c.name, type: "property", detail: c.typeName }, qi(c.name)));
      columnCache.set(t, list);
    }
    return list;
  };
  const tableOption = (t: CatalogTable, label: string, apply: string): Completion =>
    withApply({ label, type: t.kind === "table" ? "class" : "interface", detail: t.kind, boost: 1 }, apply);
  let tableList: Completion[] | null = null;
  const tableOptions = (): Completion[] =>
    (tableList ??= [
      ...current.map((t) => tableOption(t, t.name, qi(t.name))),
      ...others.flatMap((c) =>
        c.tables.map((t) => tableOption(t, `${c.schema}.${t.name}`, `${qi(c.schema as string)}.${qi(t.name)}`)),
      ),
      ...(options.schemas ?? []).map((s) => withApply({ label: s, type: "namespace" }, qi(s))),
    ]);

  // Documents are immutable: tokenize each version once, whatever the number of queries.
  const docCache = new WeakMap<Text, { sql: string; all: Token[]; toks: Token[] }>();
  const scan = (doc: Text) => {
    let entry = docCache.get(doc);
    if (!entry) {
      const sql = doc.toString();
      const all = tokenize(sql, dialect);
      entry = { sql, all, toks: all.filter((t) => !isComment(t)) };
      docCache.set(doc, entry);
    }
    return entry;
  };

  const lookup = (schema: Ident | null, name: Ident): CatalogTable | null => {
    if (!schema) return findTable(current, name);
    for (const [s, c] of loaded) if (sameIdent(schema, s)) return findTable(c.tables, name);
    return null;
  };

  return (ctx: CompletionContext) => {
    const { sql, all, toks } = scan(ctx.state.doc);
    const pos = ctx.pos;

    // The token the cursor is in, if any (comments are checked on the full list).
    const raw = all[tokenAt(all, pos)];
    if (raw && isComment(raw) && raw.from < pos && (pos < raw.to || !raw.closed || raw.kind === "lineComment")) {
      return null;
    }
    const k = tokenAt(toks, pos);
    const at = toks[k];
    let from = pos;
    let to: number | undefined;
    let before = k; // tokens before this index precede the word being completed
    /** Inside a quoted identifier: the quote character and whether it is closed. */
    let quote: { q: string; closed: boolean } | null = null;
    if (at && at.from < pos) {
      const inside = pos < at.to || !at.closed;
      if (at.kind === "word") {
        from = at.from;
      } else if (at.kind === "qident" && inside && sql[at.from] !== "[") {
        quote = { q: sql[at.from], closed: at.closed };
        from = at.from + 1;
        if (at.closed) to = at.to - 1;
      } else if (inside || at.kind === "number" || at.kind === "qident") {
        return null; // in a string or number, or right after a quoted name
      } else {
        before = k + 1; // just after punctuation or a closed string
      }
    }
    const typed = from < pos;

    const insert = (c: Completion, name: string): Completion => {
      if (!quote) return c;
      const body = name.split(quote.q).join(quote.q + quote.q);
      return { ...c, apply: quote.closed ? body : body + quote.q };
    };
    const result = (opts: Completion[], names?: string[]): CompletionResult => ({
      from,
      to,
      options: quote && names ? opts.map((c, i) => insert(c, names[i])) : opts,
      validFor: quote ? new RegExp(`^[^${quote.q}]*$`) : /^[\w$\u0080-\uffff]*$/,
    });

    // The current statement: between the `;` around the cursor.
    let s = before - 1;
    while (s >= 0 && !isPunct(sql, toks[s], ";")) s--;
    let e = before;
    while (e < toks.length && !isPunct(sql, toks[e], ";")) e++;
    const stmt = toks.slice(s + 1, e);

    // Qualifier chain before the word: `a.` or `a.b.`
    const chain: Ident[] = [];
    let q = before - 1;
    while (q > s && isPunct(sql, toks[q], ".") && chain.length < 2) {
      const prev = toks[q - 1];
      const id = prev && q - 1 > s ? identName(sql, prev) : null;
      if (!id) return null;
      chain.unshift(id);
      q -= 2;
    }

    if (chain.length > 0) {
      const refs = tableRefs(sql, stmt, dialect);
      const columns = (t: CatalogTable | null) =>
        t ? result(columnOptions(t), t.columns.map((c) => c.name)) : null;
      if (chain.length === 2) return columns(lookup(chain[0], chain[1]));
      const [name] = chain;
      const byAlias = refs.find((r) => r.alias && identsMatch(r.alias, name));
      if (byAlias) return columns(lookup(byAlias.schema, byAlias.table));
      const byTable = refs.find((r) => !r.alias && identsMatch(r.table, name)) ?? null;
      const table = byTable ? lookup(byTable.schema, byTable.table) : lookup(null, name);
      if (table) return columns(table);
      // A schema: list its tables, loading it when it is known but not loaded yet.
      const tablesOf = (c: Catalog) =>
        result(
          c.tables.map((t) => tableOption(t, t.name, qi(t.name))),
          c.tables.map((t) => t.name),
        );
      for (const [schemaName, c] of loaded) if (sameIdent(name, schemaName)) return tablesOf(c);
      const known = (options.schemas ?? []).find((x) => sameIdent(name, x));
      if (known && options.loadSchema) {
        return options.loadSchema(known).then((c) => (c ? tablesOf(c) : null));
      }
      return null;
    }

    if (!typed && !ctx.explicit && !quote) return null;

    // Columns of the tables this statement uses, then tables, schemas and keywords.
    const seen = new Set<string>();
    const cols: Completion[] = [];
    const colNames: string[] = [];
    for (const r of tableRefs(sql, stmt, dialect)) {
      const t = lookup(r.schema, r.table);
      if (!t) continue;
      columnOptions(t).forEach((c, i) => {
        if (seen.has(c.label)) return;
        seen.add(c.label);
        cols.push(c);
        colNames.push(t.columns[i].name);
      });
    }
    if (quote) {
      const named = [...current.map((t) => tableOption(t, t.name, t.name))];
      return result([...cols, ...named], [...colNames, ...current.map((t) => t.name)]);
    }
    return result([...cols, ...tableOptions(), ...dialectKeywords(dialect)]);
  };
}

/** `c` with `apply` set when the inserted text differs from the label. */
function withApply(c: Completion, apply: string): Completion {
  return apply === c.label ? c : { ...c, apply };
}
