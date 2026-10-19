import type { Filter, FilterOp } from "./types";

// Quick-filter grammar (case-insensitive keywords):
//   input := cond (AND cond)*            (empty/blank input = no filters)
//   cond  := col op value
//          | col IS [NOT] NULL
//          | col [NOT] IN '(' value (',' value)* ')'
//          | col [NOT] BETWEEN value AND value
//          | col [NOT] LIKE value | col ILIKE value | col [NOT] CONTAINS value
//          | ANY (CONTAINS | NOT CONTAINS | = | LIKE) value      (any column)
//   op    := = != <> < > <= >=
//   col   := bare word | "…" | `…`          (the quote char doubled escapes itself)
//   value := bare word | number | '…' | "…" (the quote char doubled escapes itself)
//
// Decisions: a bare reserved word (and, not, is, null, in, between, like, ilike, contains,
// any) is never a value: write it quoted ('and'). Bare `any` as a column is the any-column
// keyword, "any" is a real column. `any` accepts only the ops Filter allows for a null
// column (eq, contains, notContains, like). `NOT ILIKE` does not exist (no Filter op).
// `or` is not supported (Filters are ANDed). An ambiguous case-insensitive column match is
// an error. Any error returns no filters at all.

const RESERVED = new Set([
  "and", "not", "is", "null", "in", "between", "like", "ilike", "contains", "any",
]);

type Token =
  | { k: "word"; s: string }
  | { k: "sq" | "dq" | "bt"; s: string }
  | { k: "op"; s: string }
  | { k: "(" | ")" | "," }
  | { k: "end" };

class QuickFilterError extends Error {}
const fail = (m: string): never => {
  throw new QuickFilterError(m);
};

const QUOTES: Record<string, "sq" | "dq" | "bt"> = { "'": "sq", '"': "dq", "`": "bt" };

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c in QUOTES) {
      let s = "";
      i++;
      for (;;) {
        if (i >= input.length) fail(`unterminated ${c} quote`);
        if (input[i] === c) {
          if (input[i + 1] === c) {
            s += c;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += input[i++];
      }
      out.push({ k: QUOTES[c], s });
    } else if (c === "(" || c === ")" || c === ",") {
      out.push({ k: c });
      i++;
    } else if (c === "=" || c === "!" || c === "<" || c === ">") {
      const two = input.slice(i, i + 2);
      const op = ["!=", "<>", "<=", ">="].includes(two) ? two : c;
      if (op === "!") fail('unexpected "!"');
      out.push({ k: "op", s: op });
      i += op.length;
    } else {
      let j = i;
      while (j < input.length && !/[\s'"`(),=!<>]/.test(input[j])) j++;
      out.push({ k: "word", s: input.slice(i, j) });
      i = j;
    }
  }
  out.push({ k: "end" });
  return out;
}

const OPS: Record<string, FilterOp> = {
  "=": "eq", "!=": "neq", "<>": "neq", "<": "lt", ">": "gt", "<=": "lte", ">=": "gte",
};

class Parser {
  private p = 0;
  constructor(
    private t: Token[],
    private columns: string[],
  ) {}

  private peek = () => this.t[this.p];
  private next = () => this.t[this.p++];
  private kw(): string | null {
    const t = this.peek();
    return t.k === "word" ? t.s.toLowerCase() : null;
  }
  private eatKw(w: string): boolean {
    if (this.kw() === w) {
      this.p++;
      return true;
    }
    return false;
  }
  private describe(t: Token): string {
    if (t.k === "end") return "end of input";
    if (t.k === "sq") return `'${t.s}'`;
    if (t.k === "bt") return `\`${t.s}\``;
    return "s" in t ? `"${t.s}"` : `"${t.k}"`;
  }

  parseAll(): Filter[] {
    const out: Filter[] = [];
    if (this.peek().k === "end") return out;
    for (;;) {
      out.push(this.cond());
      if (this.peek().k === "end") return out;
      if (!this.eatKw("and")) fail(`expected AND, found ${this.describe(this.peek())}`);
    }
  }

  private column(): string | null {
    const t = this.next();
    if (t.k === "word" && t.s.toLowerCase() === "any") return null;
    if (t.k !== "word" && t.k !== "dq" && t.k !== "bt") {
      return fail(`expected a column, found ${this.describe(t)}`);
    }
    const exact = this.columns.find((c) => c === t.s);
    if (exact !== undefined) return exact;
    const ci = this.columns.filter((c) => c.toLowerCase() === t.s.toLowerCase());
    if (ci.length === 1) return ci[0];
    if (ci.length > 1) return fail(`ambiguous column "${t.s}"`);
    return fail(`unknown column "${t.s}"`);
  }

  private value(): string {
    const t = this.next();
    if (t.k === "sq" || t.k === "dq") return t.s;
    if (t.k === "word") {
      if (t.s.toLowerCase() === "null") return fail("use IS NULL / IS NOT NULL to test for NULL");
      if (RESERVED.has(t.s.toLowerCase())) {
        return fail(`"${t.s}" is a keyword: quote it ('${t.s}') to use it as a value`);
      }
      return t.s;
    }
    return fail(`expected a value, found ${this.describe(t)}`);
  }

  private cond(): Filter {
    const column = this.column();
    const mk = (op: FilterOp, values: string[]): Filter => ({ column, op, values });
    const anyOnly = (op: FilterOp) => {
      if (column === null && !["eq", "contains", "notContains", "like"].includes(op)) {
        fail("any column supports only =, CONTAINS, NOT CONTAINS and LIKE");
      }
    };
    const simple = (op: FilterOp) => {
      anyOnly(op);
      return mk(op, [this.value()]);
    };

    const t = this.peek();
    if (t.k === "op") {
      this.p++;
      const op = OPS[t.s];
      if (!op) return fail(`unexpected "${t.s}"`);
      return simple(op);
    }
    const w = this.kw();
    if (w === null) return fail(`expected an operator, found ${this.describe(t)}`);
    this.p++;
    switch (w) {
      case "is": {
        const neg = this.eatKw("not");
        if (!this.eatKw("null")) fail("expected NULL after IS");
        anyOnly("isNull");
        return mk(neg ? "isNotNull" : "isNull", []);
      }
      case "like":
        return simple("like");
      case "ilike":
        return simple("ilike");
      case "contains":
        return simple("contains");
      case "in":
        return this.inList(mk, false, anyOnly);
      case "between":
        return this.between(mk, false, anyOnly);
      case "not": {
        const w2 = this.kw();
        this.p++;
        switch (w2) {
          case "in":
            return this.inList(mk, true, anyOnly);
          case "between":
            return this.between(mk, true, anyOnly);
          case "like":
            return simple("notLike");
          case "contains":
            return simple("notContains");
          case "ilike":
            return fail("NOT ILIKE is not supported");
          default:
            return fail("expected IN, BETWEEN, LIKE or CONTAINS after NOT");
        }
      }
      default:
        return fail(`expected an operator, found ${this.describe(t)}`);
    }
  }

  private inList(
    mk: (op: FilterOp, v: string[]) => Filter,
    neg: boolean,
    anyOnly: (op: FilterOp) => void,
  ): Filter {
    const op = neg ? "notIn" : "in";
    anyOnly(op);
    if (this.next().k !== "(") fail("expected ( after IN");
    const values = [this.value()];
    while (this.peek().k === ",") {
      this.p++;
      values.push(this.value());
    }
    if (this.next().k !== ")") fail("expected , or ) in the IN list");
    return mk(op, values);
  }

  private between(
    mk: (op: FilterOp, v: string[]) => Filter,
    neg: boolean,
    anyOnly: (op: FilterOp) => void,
  ): Filter {
    const op = neg ? "notBetween" : "between";
    anyOnly(op);
    const a = this.value();
    if (!this.eatKw("and")) fail("expected AND in BETWEEN");
    return mk(op, [a, this.value()]);
  }
}

/** Parse the quick-filter bar text. Any error gives `filters: []` and a message. */
export function parseQuickFilter(
  input: string,
  columns: string[],
): { filters: Filter[]; error: string | null } {
  try {
    return { filters: new Parser(tokenize(input), columns).parseAll(), error: null };
  } catch (e) {
    if (e instanceof QuickFilterError) return { filters: [], error: e.message };
    throw e;
  }
}

const SIMPLE_WORD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMBER = /^-?\d+(\.\d+)?$/;
const quote = (s: string, q: string) => `${q}${s.split(q).join(q + q)}${q}`;

const fmtColumn = (c: string | null): string =>
  c === null ? "any" : SIMPLE_WORD.test(c) && !RESERVED.has(c.toLowerCase()) ? c : quote(c, '"');

const fmtValue = (v: string): string =>
  NUMBER.test(v) || (SIMPLE_WORD.test(v) && !RESERVED.has(v.toLowerCase())) ? v : quote(v, "'");

const SYMBOL: Partial<Record<FilterOp, string>> = {
  eq: "=", neq: "!=", lt: "<", gt: ">", lte: "<=", gte: ">=",
  like: "LIKE", notLike: "NOT LIKE", ilike: "ILIKE",
  contains: "CONTAINS", notContains: "NOT CONTAINS",
};

/** Values an operator takes when not 1 (IN / NOT IN take a list of one or more). */
export const ARITY: Readonly<Partial<Record<FilterOp, number>>> = { isNull: 0, isNotNull: 0, between: 2, notBetween: 2 };
/** The operators an any-column filter may use (the backend allows these four). */
export const ANY_OPS: readonly FilterOp[] = ["eq", "contains", "notContains", "like"];

/**
 * True when `parseQuickFilter(formatQuickFilter(filters))` gives the same filters, i.e. the
 * bar can show them. False for a `raw` filter, an any-column filter the grammar rejects, or
 * a filter with the wrong number of values (the UI shows an "advanced" badge instead).
 */
export function isQuickFilterRepresentable(filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.op === "raw") return false;
    if (f.column === null && !ANY_OPS.includes(f.op)) return false;
    if (f.op === "in" || f.op === "notIn") return f.values.length >= 1;
    return f.values.length === (ARITY[f.op] ?? 1);
  });
}

function formatOne(f: Filter): string {
  if (f.op === "raw") return `(${f.values[0] ?? ""})`;
  const col = fmtColumn(f.column);
  switch (f.op) {
    case "isNull":
      return `${col} IS NULL`;
    case "isNotNull":
      return `${col} IS NOT NULL`;
    case "in":
    case "notIn":
      return `${col} ${f.op === "in" ? "IN" : "NOT IN"} (${f.values.map(fmtValue).join(", ")})`;
    case "between":
    case "notBetween":
      return `${col} ${f.op === "between" ? "BETWEEN" : "NOT BETWEEN"} ${fmtValue(f.values[0] ?? "")} AND ${fmtValue(f.values[1] ?? "")}`;
    default:
      return `${col} ${SYMBOL[f.op]} ${fmtValue(f.values[0] ?? "")}`;
  }
}

/** Inverse of parseQuickFilter, joined by " AND ". A `raw` filter shows as `(sql)` and cannot be re-parsed. */
export function formatQuickFilter(filters: Filter[]): string {
  return filters.map(formatOne).join(" AND ");
}
