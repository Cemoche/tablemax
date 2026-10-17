import { type CompletionSource, autocompletion } from "@codemirror/autocomplete";
import { defaultKeymap, isolateHistory, toggleComment, toggleLineComment } from "@codemirror/commands";
import { HighlightStyle, LanguageSupport, syntaxHighlighting } from "@codemirror/language";
import { MySQL, PostgreSQL, SQLite } from "@codemirror/lang-sql";
import { EditorSelection as CmSelection, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef, useState } from "react";
import { isModalOpen, matchShortcut } from "../../lib/shortcuts";
import { strings } from "../../lib/strings";
import { registerEditorCommands } from "./editorCommands";
import type { Dialect } from "../../lib/types";

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
  /** Registers this editor's commands (toggle comment…) for the command palette. */
  tabId?: string;
  /** Replaces lang-sql's keyword completion (see `buildCompletionSource`). */
  completionSource?: CompletionSource | null;
  /** Non-blocking message for the user (a failed format). */
  onNotice?: (message: string) => void;
  /** The CodeMirror view once created (null on unmount), for insert/replace from panels. */
  onView?: (view: EditorView | null) => void;
}

const DIALECTS = { postgres: PostgreSQL, mySql: MySQL, sqlite: SQLite } as const;
const FORMAT_LANGUAGE = { postgres: "postgresql", mySql: "mysql", sqlite: "sqlite" } as const;

type Formatter = (typeof import("sql-formatter"))["format"];
let formatter: Promise<Formatter> | null = null;
/** sql-formatter is only needed on demand: load it on the first format. */
const loadFormatter = () => (formatter ??= import("sql-formatter").then((m) => m.format));

/**
 * Formats the selection, or the whole text when nothing is selected, with sql-formatter
 * (upper-case keywords) in ONE transaction, so a single undo restores the original. A text
 * sql-formatter cannot parse is left untouched and `onError` is called.
 */
export async function formatEditor(view: EditorView, dialect: Dialect, onError: () => void): Promise<void> {
  const state = view.state;
  const sel = state.selection.main;
  const [from, to] = sel.empty ? [0, state.doc.length] : [sel.from, sel.to];
  const source = state.sliceDoc(from, to);
  if (!source.trim()) return;
  const format = await loadFormatter();
  // The text changed while sql-formatter loaded: formatting the old text would undo edits.
  if (view.state.doc !== state.doc) return;
  let out: string;
  try {
    out = format(source, { language: FORMAT_LANGUAGE[dialect], keywordCase: "upper" });
  } catch {
    onError();
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

/** Replaces the whole content with `text` in ONE undoable transaction. */
export function replaceDocument(view: EditorView, text: string): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: CmSelection.cursor(text.length),
    annotations: isolateHistory.of("full"),
    userEvent: "input.paste",
    scrollIntoView: true,
  });
  view.focus();
}

// All colors come from the design tokens (they follow the system color scheme).
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

function usePrefersDark() {
  const mq = () =>
    typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const [dark, setDark] = useState(() => mq()?.matches ?? false);
  useEffect(() => {
    const m = mq();
    if (!m) return;
    const on = () => setDark(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return dark;
}

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

  const viewRef = useRef<EditorView | null>(null);
  const formatRef = useRef(() => {
    const view = viewRef.current;
    if (view) void formatEditor(view, dialectRef.current, () => noticeRef.current?.(strings.query.formatFailed));
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

  const dark = usePrefersDark();
  const extensions = useMemo(
    () => [
      // The language without lang-sql's keyword completion: ours replaces it.
      new LanguageSupport(DIALECTS[dialect].language),
      autocompletion({
        override: [(ctx) => completionRef.current?.(ctx) ?? null],
      }),
      buildEditorTheme(dark),
      highlight,
      EditorView.lineWrapping,
      Prec.highest(
        keymap.of([
          {
            // Matched on e.code (layout independent), like the app shortcuts.
            any: (view, e) => {
              if (isModalOpen()) return false;
              if (matchShortcut(e, "Mod+Shift+F")) {
                formatRef.current();
                return true;
              }
              if (matchShortcut(e, "Mod+/")) return toggleLineComment(view);
              return false;
            },
          },
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
    [dialect, dark],
  );

  return (
    <CodeMirror
      value={value}
      height="100%"
      style={{ height: "100%" }}
      aria-label={strings.query.editorLabel}
      theme="none"
      extensions={extensions}
      basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true, autocompletion: false }}
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
