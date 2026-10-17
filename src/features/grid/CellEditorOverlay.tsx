import { useEffect, useRef, useState } from "react";
import { toAppError } from "../../lib/errors";
import { strings } from "../../lib/strings";

interface Props {
  /** The text to edit (the cell's full value, or the typed character that opened it). */
  value: string;
  /** Set for a truncated cell: the whole value is loaded before it can be edited. */
  load?: () => Promise<string>;
  /** Each edit; Glide's overlay commits the last one on Enter / Tab / click outside. */
  onChange: (text: string) => void;
  /** Runs when the editor opens; the function it returns runs when the editor closes. */
  onMount?: () => (() => void) | void;
}

/**
 * The grid's cell editor (rendered by Glide's overlay, which handles Enter, Shift+Enter
 * for a new line, Tab and Escape). A truncated value is never offered for editing: the
 * editor shows "loading…" until `load` resolves, or the error if it fails.
 */
export function CellEditorOverlay({ value, load, onChange, onMount }: Props) {
  const [state, setState] = useState<
    { s: "ready"; text: string } | { s: "loading" } | { s: "failed"; message: string }
  >(load ? { s: "loading" } : { s: "ready", text: value });
  const loadRef = useRef(load);
  const mountRef = useRef(onMount);

  useEffect(() => mountRef.current?.(), []);

  useEffect(() => {
    const fn = loadRef.current;
    if (!fn) return;
    let live = true;
    fn().then(
      (text) => live && setState({ s: "ready", text }),
      (e) => live && setState({ s: "failed", message: toAppError(e).message }),
    );
    return () => {
      live = false;
    };
  }, []);

  if (state.s === "loading") {
    return <div className="px-2 py-1 text-muted">{strings.grid.editorLoading}</div>;
  }
  if (state.s === "failed") {
    return <div className="px-2 py-1 text-danger">{strings.grid.editorLoadFailed(state.message)}</div>;
  }
  return (
    <textarea
      autoFocus
      aria-label={strings.grid.editorLabel}
      value={state.text}
      rows={Math.min(8, Math.max(1, state.text.split("\n").length))}
      spellCheck={false}
      onFocus={(e) => {
        const n = e.currentTarget.value.length;
        e.currentTarget.setSelectionRange(n, n);
      }}
      onChange={(e) => {
        setState({ s: "ready", text: e.target.value });
        onChange(e.target.value);
      }}
      className="block min-w-48 resize border-0 bg-surface px-2 py-1 font-mono text-fg outline-none"
    />
  );
}
