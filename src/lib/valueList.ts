import { strings } from "./strings";

// A comma-separated list of values (the IN / NOT IN field of the filter builder). Quoting
// follows the quick filter: '…' or "…", the quote char doubled escapes itself. Bare values
// are trimmed and may hold spaces but no quote; an empty value must be written ''.

export function splitValueList(text: string): { values: string[]; error: string | null } {
  const values: string[] = [];
  const fail = (error: string) => ({ values: [], error });
  if (text.trim() === "") return fail(strings.filters.listEmpty);
  let i = 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    const q = text[i];
    if (q === "'" || q === '"') {
      let s = "";
      i++;
      for (;;) {
        if (i >= text.length) return fail(strings.filters.listUnterminated(q));
        if (text[i] === q) {
          if (text[i + 1] === q) {
            s += q;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += text[i++];
      }
      while (i < text.length && /\s/.test(text[i])) i++;
      if (i < text.length && text[i] !== ",") return fail(strings.filters.listAfterQuote);
      values.push(s);
    } else {
      let j = i;
      while (j < text.length && text[j] !== ",") j++;
      const s = text.slice(i, j).trim();
      if (s === "") return fail(strings.filters.listEmptyItem);
      if (/['"]/.test(s)) return fail(strings.filters.listStrayQuote);
      values.push(s);
      i = j;
    }
    if (i >= text.length) return { values, error: null };
    i++; // the comma
  }
}

const needsQuotes = (v: string) => v === "" || /[,'"]/.test(v) || v.trim() !== v;

/** Inverse of splitValueList: quotes (with ') only the values that need it. */
export function formatValueList(values: string[]): string {
  return values.map((v) => (needsQuotes(v) ? `'${v.split("'").join("''")}'` : v)).join(", ");
}
