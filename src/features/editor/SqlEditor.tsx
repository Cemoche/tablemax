import { defaultKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { MySQL, PostgreSQL, SQLite, sql } from "@codemirror/lang-sql";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo, useRef } from "react";
import { strings } from "../../lib/strings";
import { useResolvedDark } from "../../lib/theme";
import type { Dialect } from "../../lib/types";
import { useSettings } from "../../stores/settings";

export type RunMode = "current" | "all";
export interface EditorSelection {
  from: number;
  to: number;
  head: number;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  dialect: Dialect;
  /** Ctrl+Enter ("current") / Ctrl+Shift+Enter ("all"), bound while the editor has focus. */
  onRun: (mode: RunMode) => void;
  onSelectionChange?: (sel: EditorSelection) => void;
}

const DIALECTS = { postgres: PostgreSQL, mySql: MySQL, sqlite: SQLite } as const;

// All colors come from the design tokens (they follow data-theme / the system color scheme).
export const editorThemeSpec = {
  "&": {
    height: "100%",
    color: "var(--text)",
    backgroundColor: "var(--surface)",
    fontSize: "var(--text-md)",
  },
  ".cm-scroller": { fontFamily: "var(--font-mono)", backgroundColor: "var(--surface)" },
  ".cm-content": { caretColor: "var(--text)", color: "var(--text)", backgroundColor: "var(--surface)" },
  ".cm-line": { color: "var(--text)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)" },
  ".cm-gutters": {
    backgroundColor: "var(--surface-2)",
    color: "var(--text-muted)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--text) 5%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--surface)", color: "var(--text)" },
  ".cm-tooltip": {
    backgroundColor: "var(--surface-2)",
    color: "var(--text)",
    border: "1px solid var(--border)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-contrast)",
  },
};

/** `dark` only selects CodeMirror's base theme; every color comes from the tokens. */
export const buildEditorTheme = (dark: boolean) => EditorView.theme(editorThemeSpec, { dark });

/** User font settings; an empty family keeps the `--font-mono` token. */
export const buildEditorFont = (family: string, size: number) =>
  EditorView.theme({
    "&": { fontSize: `${size}px` },
    ...(family ? { ".cm-scroller": { fontFamily: family } } : {}),
  });

const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--accent)", fontWeight: "600" },
    { tag: [t.string, t.special(t.string)], color: "var(--success)" },
    { tag: [t.number, t.bool, t.null], color: "var(--warning)" },
    { tag: [t.lineComment, t.blockComment], color: "var(--text-muted)", fontStyle: "italic" },
    { tag: [t.typeName, t.standard(t.name)], color: "var(--env-staging)" },
    { tag: [t.operator, t.punctuation], color: "var(--text-muted)" },
  ]),
);

export function SqlEditor({ value, onChange, dialect, onRun, onSelectionChange }: Props) {
  // Latest callbacks, so the keymap extension never has to be rebuilt.
  const runRef = useRef(onRun);
  runRef.current = onRun;

  const dark = useResolvedDark();
  const fontFamily = useSettings((s) => s.settings.editorFontFamily);
  const fontSize = useSettings((s) => s.settings.editorFontSize);
  const extensions = useMemo(
    () => [
      sql({ dialect: DIALECTS[dialect] }),
      buildEditorTheme(dark),
      buildEditorFont(fontFamily, fontSize),
      highlight,
      EditorView.lineWrapping,
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              runRef.current("current");
              return true;
            },
          },
          {
            key: "Mod-Shift-Enter",
            run: () => {
              runRef.current("all");
              return true;
            },
          },
        ]),
      ),
      keymap.of(defaultKeymap),
    ],
    [dialect, dark, fontFamily, fontSize],
  );

  return (
    <CodeMirror
      value={value}
      height="100%"
      style={{ height: "100%" }}
      aria-label={strings.query.editorLabel}
      theme="none"
      extensions={extensions}
      basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true }}
      onChange={onChange}
      onUpdate={(u) => {
        if (onSelectionChange && (u.selectionSet || u.docChanged)) {
          const r = u.state.selection.main;
          onSelectionChange({ from: r.from, to: r.to, head: r.head });
        }
      }}
    />
  );
}
