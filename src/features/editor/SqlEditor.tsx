import { type CompletionSource, autocompletion } from "@codemirror/autocomplete";
import { defaultKeymap, isolateHistory, toggleComment, toggleLineComment } from "@codemirror/commands";
import { HighlightStyle, LanguageSupport, syntaxHighlighting } from "@codemirror/language";
import { MySQL, PostgreSQL, SQLite } from "@codemirror/lang-sql";
import { EditorSelection as CmSelection, Prec, RangeSetBuilder, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, keymap } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import CodeMirror from "@uiw/react-codemirror";
import { type CSSProperties, useEffect, useMemo, useRef } from "react";
import { useEffectiveShortcut } from "../../lib/keymap";
import { isModalOpen, matchCombination, matchShortcut } from "../../lib/shortcuts";
import { strings } from "../../lib/strings";
import { useResolvedDark } from "../../lib/theme";
import { registerEditorCommands } from "./editorCommands";
import { type Statement, delimiterAt, splitStatements, statementAt } from "./splitStatements";
import type { Dialect } from "../../lib/types";
import { useSettings } from "../../stores/settings";
import { isValidFontFamily } from "../settings/bounds";

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
  /** editor.run ("current") / editor.runAll ("all"), bound while the editor has focus. */
  onRun: (mode: RunMode) => void;
  onSelectionChange?: (sel: EditorSelection) => void;
  /** Registers this editor's commands (toggle comment…) for the command palette. */
  tabId?: string;
  /** Replaces lang-sql's keyword completion (see `buildCompletionSource`). */
  completionSource?: CompletionSource | null;
  /** Non-blocking message for the user (a failed format). */
  onNotice?: (message: string) => void;
  /** The CodeMirror view once created (null on unmount), for insert/replace from panels. */
  onView?: (view: EditorView | null) => void;
}

// Mod-Enter (insertBlankLine), Mod-/ (toggleComment) and Mod-i (selectParentSyntax) are
// editor.run / editor.comment / editor.format's keys: dropped, so a rebound action leaves
// its old keys inert. Mod-[ / Mod-] (indentLess / indentMore) are tab.previous / tab.next's
// (spec §5.5: the tab keys win in the editor). Shift-Mod-k (deleteLine) is
// connection.open's key (#88): the app key wins, it must not delete a line on its way.
const CM_DEFAULT_KEYMAP = defaultKeymap.filter(
  (b) => !["Mod-Enter", "Mod-/", "Mod-i", "Mod-[", "Mod-]", "Shift-Mod-k"].includes(b.key ?? ""),
);

export const DIALECTS = { postgres: PostgreSQL, mySql: MySQL, sqlite: SQLite } as const;
const FORMAT_LANGUAGE = { postgres: "postgresql", mySql: "mysql", sqlite: "sqlite" } as const;

type Formatter = (typeof import("sql-formatter"))["format"];
let formatter: Promise<Formatter> | null = null;
/** sql-formatter is only needed on demand: load it on the first format. */
const loadFormatter = () => (formatter ??= import("sql-formatter").then((m) => m.format));

/** A MySQL `DELIMITER` client command line (sql-formatter knows nothing of it). */
const DELIMITER_LINE = /^\s*DELIMITER\s/im;

/**
 * Formats the selection, or the whole text when nothing is selected, with sql-formatter
 * (upper-case keywords) in ONE transaction, so a single undo restores the original. A text
 * sql-formatter cannot parse is left untouched and `onNotice` gets `formatFailed`. MySQL
 * text holding a `DELIMITER` line, or a selection inside a `DELIMITER` region, is not
 * formatted at all (sql-formatter would break the script): `onNotice` says so.
 */
export async function formatEditor(
  view: EditorView,
  dialect: Dialect,
  onNotice: (message: string) => void,
): Promise<void> {
  const state = view.state;
  const sel = state.selection.main;
  const [from, to] = sel.empty ? [0, state.doc.length] : [sel.from, sel.to];
  const source = state.sliceDoc(from, to);
  if (!source.trim()) return;
  if (
    dialect === "mySql" &&
    (DELIMITER_LINE.test(source) || delimiterAt(state.doc.toString(), from, dialect) !== ";")
  ) {
    onNotice(strings.query.formatDelimiter);
    return;
  }
  const format = await loadFormatter();
  // The text changed while sql-formatter loaded: formatting the old text would undo edits.
  if (view.state.doc !== state.doc) return;
  let out: string;
  try {
    out = format(source, { language: FORMAT_LANGUAGE[dialect], keywordCase: "upper" });
  } catch {
    onNotice(strings.query.formatFailed);
    return;
  }
  if (out === source) return;
  view.dispatch({
    changes: { from, to, insert: out },
    selection: sel.empty
      ? CmSelection.cursor(Math.min(sel.head, out.length))
      : CmSelection.range(from, from + out.length),
    annotations: isolateHistory.of("full"),
    userEvent: "input.format",
    scrollIntoView: true,
  });
}

/**
 * Inserts `text` at the cursor (replacing the selection) in ONE undoable transaction and
 * puts the cursor after it.
 */
export function insertAtCursor(view: EditorView, text: string): void {
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: CmSelection.cursor(sel.from + text.length),
    annotations: isolateHistory.of("full"),
    userEvent: "input.paste",
    scrollIntoView: true,
  });
  view.focus();
}

// All colors come from the design tokens (they follow data-theme / the system color scheme).
// The user's font reaches the editor only through the --editor-font-family and
// --editor-font-size custom properties set on its container (CSSOM, never CSS text), so
// the theme rules stay static and a settings value can never add a CSS rule.
export const editorThemeSpec = {
  "&": {
    height: "100%",
    color: "var(--text)",
    backgroundColor: "var(--surface)",
    fontSize: "var(--editor-font-size, var(--text-md))",
  },
  ".cm-scroller": {
    fontFamily: "var(--editor-font-family, var(--font-mono))",
    backgroundColor: "var(--surface)",
  },
  ".cm-content": { caretColor: "var(--text)", color: "var(--text)", backgroundColor: "var(--surface)" },
  ".cm-line": { color: "var(--text)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--sql-selection)" },
  // The statement Run Current would run (spec §5.1 "requête courante"), while nothing is
  // selected: a line background, so it never hides a selection.
  ".cm-currentStatement": { backgroundColor: "var(--sql-current)" },
  ".cm-gutters": {
    backgroundColor: "var(--surface-2)",
    color: "var(--text-muted)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
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

/**
 * The container style carrying the user's font. A family outside the safe grammar is
 * ignored (defence in depth: the settings store and the backend reject it already); an
 * empty one leaves the `--font-mono` fallback.
 */
export function editorFontStyle(fontFamily: string, fontSize?: number): CSSProperties {
  const vars: Record<string, string> = {};
  if (fontFamily && isValidFontFamily(fontFamily)) vars["--editor-font-family"] = fontFamily;
  if (fontSize && Number.isFinite(fontSize)) vars["--editor-font-size"] = `${fontSize}px`;
  return { height: "100%", ...vars } as CSSProperties;
}

/**
 * SQL colours of spec §5.1, by role, from the --sql-* tokens (dark / light in tokens.css):
 * keywords (types, booleans and NULL too), functions (the dialect's builtins), numbers,
 * strings, comments. Quoted identifiers are names: plain text, not strings.
 */
export const sqlHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.typeName, t.bool, t.null], color: "var(--sql-keyword)" },
  { tag: [t.standard(t.name), t.function(t.variableName)], color: "var(--sql-function)" },
  { tag: t.number, color: "var(--sql-number)" },
  { tag: t.string, color: "var(--sql-string)" },
  { tag: t.special(t.string), color: "var(--text)" },
  { tag: [t.lineComment, t.blockComment], color: "var(--sql-comment)" },
]);

export const highlight = syntaxHighlighting(sqlHighlightStyle);

/** Longer texts get no current-statement highlight: it splits the whole text on each edit. */
const CURRENT_STATEMENT_MAX = 200_000;
const currentStatementLine = Decoration.line({ class: "cm-currentStatement" });

/**
 * Highlights the lines of the statement Run Current would run (`statementAt` of the
 * cursor, as QueryTab's run): nothing while a selection is made (the selection runs).
 */
export function currentStatementHighlight(dialect: Dialect) {
  let split: { doc: Text; stmts: Statement[] } | null = null;
  const build = (view: EditorView): DecorationSet => {
    const { state } = view;
    const sel = state.selection.main;
    if (!sel.empty || state.doc.length > CURRENT_STATEMENT_MAX) return Decoration.none;
    if (split?.doc !== state.doc) split = { doc: state.doc, stmts: splitStatements(state.doc.toString(), dialect) };
    const stmt = statementAt(split.stmts, sel.head);
    if (!stmt) return Decoration.none;
    const builder = new RangeSetBuilder<Decoration>();
    const last = state.doc.lineAt(stmt.to).number;
    for (let n = state.doc.lineAt(stmt.from).number; n <= last; n++) {
      const line = state.doc.line(n);
      builder.add(line.from, line.from, currentStatementLine);
    }
    return builder.finish();
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

export function SqlEditor({
  value,
  onChange,
  dialect,
  onRun,
  onSelectionChange,
  tabId,
  completionSource,
  onNotice,
  onView,
}: Props) {
  // Latest callbacks and inputs, so the extensions never have to be rebuilt for them.
  const runRef = useRef(onRun);
  runRef.current = onRun;
  const completionRef = useRef(completionSource);
  completionRef.current = completionSource;
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;
  const viewCbRef = useRef(onView);
  viewCbRef.current = onView;
  useEffect(() => () => viewCbRef.current?.(null), []);
  const dialectRef = useRef(dialect);
  dialectRef.current = dialect;
  // The effective combinations, read by the keymap below through a ref: a keymap change
  // in the settings applies at once without rebuilding the extensions.
  const keys = {
    run: useEffectiveShortcut("editor.run"),
    runAll: useEffectiveShortcut("editor.runAll"),
    format: useEffectiveShortcut("editor.format"),
    comment: useEffectiveShortcut("editor.comment"),
  };
  const keysRef = useRef(keys);
  keysRef.current = keys;

  const viewRef = useRef<EditorView | null>(null);
  const formatRef = useRef(() => {
    const view = viewRef.current;
    if (view) void formatEditor(view, dialectRef.current, (m) => noticeRef.current?.(m));
  });
  useEffect(() => {
    if (!tabId) return;
    return registerEditorCommands(tabId, {
      focus: () => viewRef.current?.focus(),
      toggleComment: () => {
        const view = viewRef.current;
        if (!view) return;
        view.focus();
        toggleComment(view);
      },
      format: () => {
        viewRef.current?.focus();
        formatRef.current();
      },
    });
  }, [tabId]);

  const dark = useResolvedDark();
  const fontFamily = useSettings((s) => s.settings.editorFontFamily);
  const fontSize = useSettings((s) => s.settings.editorFontSize);
  const extensions = useMemo(
    () => [
      // The language without lang-sql's keyword completion: ours replaces it.
      new LanguageSupport(DIALECTS[dialect].language),
      autocompletion({
        override: [(ctx) => completionRef.current?.(ctx) ?? null],
      }),
      buildEditorTheme(dark),
      highlight,
      currentStatementHighlight(dialect),
      EditorView.lineWrapping,
      Prec.highest(
        keymap.of([
          {
            // Matched like the app shortcuts (matchShortcut: letters as the layout types them).
            any: (view, e) => {
              if (isModalOpen()) return false;
              const k = keysRef.current;
              // Holding a combination acts once: its repeats are swallowed, not passed on.
              if (e.repeat) return [k.run, k.runAll, k.format, k.comment].some((s) => matchCombination(e, s));
              if (matchShortcut(e, k.run)) {
                runRef.current("current");
                return true;
              }
              if (matchShortcut(e, k.runAll)) {
                runRef.current("all");
                return true;
              }
              if (matchShortcut(e, k.format)) {
                formatRef.current();
                return true;
              }
              if (matchShortcut(e, k.comment)) return toggleLineComment(view);
              return false;
            },
          },
        ]),
      ),
      keymap.of(CM_DEFAULT_KEYMAP),
    ],
    [dialect, dark],
  );

  return (
    <CodeMirror
      value={value}
      height="100%"
      style={editorFontStyle(fontFamily, fontSize)}
      aria-label={strings.query.editorLabel}
      theme="none"
      extensions={extensions}
      // No active-line band: the current statement is highlighted instead (§5.1).
      basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false, autocompletion: false, defaultKeymap: false }}
      onChange={onChange}
      onCreateEditor={(view) => {
        viewRef.current = view;
        viewCbRef.current?.(view);
      }}
      onUpdate={(u) => {
        if (onSelectionChange && (u.selectionSet || u.docChanged)) {
          const r = u.state.selection.main;
          onSelectionChange({ from: r.from, to: r.to, head: r.head });
        }
      }}
    />
  );
}
