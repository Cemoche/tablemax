/**
 * Re-indents a JSON text (two spaces) for display, without parsing its values: numbers,
 * key order, duplicate keys and string contents stay exactly as written (JSON.parse
 * would round big numbers, reorder integer keys and drop duplicates). Only whitespace
 * outside strings changes. Text that is not valid JSON is returned unchanged.
 */
export function prettyJson(raw: string): string {
  try {
    JSON.parse(raw);
  } catch {
    return raw;
  }
  const pad = (depth: number) => "\n" + "  ".repeat(depth);
  let out = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    switch (ch) {
      case '"':
        inString = true;
        out += ch;
        break;
      case "{":
      case "[": {
        let j = i + 1;
        while (j < raw.length && isSpace(raw[j])) j++;
        if (raw[j] === (ch === "{" ? "}" : "]")) {
          out += ch + raw[j];
          i = j;
        } else {
          depth++;
          out += ch + pad(depth);
        }
        break;
      }
      case "}":
      case "]":
        depth--;
        out += pad(depth) + ch;
        break;
      case ",":
        out += "," + pad(depth);
        break;
      case ":":
        out += ": ";
        break;
      default:
        if (!isSpace(ch)) out += ch;
    }
  }
  return out;
}

/** JSON's insignificant whitespace. */
const isSpace = (ch: string) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
