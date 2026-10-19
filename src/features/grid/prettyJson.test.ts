import { expect, test } from "vitest";
import { prettyJson } from "./prettyJson";

test("indents objects and arrays by two spaces", () => {
  expect(prettyJson('{"a":1,"b":[true,null,{"c":"x"}]}')).toBe(
    '{\n  "a": 1,\n  "b": [\n    true,\n    null,\n    {\n      "c": "x"\n    }\n  ]\n}',
  );
});

test("keeps empty containers, scalars and existing whitespace-free output", () => {
  expect(prettyJson('{ "a" : { } , "b" : [ ] }')).toBe('{\n  "a": {},\n  "b": []\n}');
  expect(prettyJson("42")).toBe("42");
  expect(prettyJson('"x"')).toBe('"x"');
});

test("never changes a token: big numbers, key order, duplicate keys, string content", () => {
  // JSON.parse would round the number, reorder integer keys and drop the duplicate.
  const raw = '{"b":12345678901234567890123,"2":0,"1":1.50,"b":2,"s":"a, {b}: [c] \\" \\\\"}';
  const pretty = prettyJson(raw);
  expect(pretty).toBe(
    '{\n  "b": 12345678901234567890123,\n  "2": 0,\n  "1": 1.50,\n  "b": 2,\n  "s": "a, {b}: [c] \\" \\\\"\n}',
  );
  // Removing the added whitespace outside strings gives the original back.
  expect(pretty.replace(/\n\s*/g, "").replace(/": /g, '":')).toBe(raw);
});

test("returns invalid JSON unchanged", () => {
  expect(prettyJson("{not json")).toBe("{not json");
  expect(prettyJson("")).toBe("");
});
