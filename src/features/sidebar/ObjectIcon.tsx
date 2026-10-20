import { Table, View } from "lucide-react";
import type { ReactNode } from "react";
import { strings } from "../../lib/strings";

export const OBJECT_ICON_KINDS = ["table", "view", "materializedView", "function", "procedure"] as const;
export type ObjectIconKind = (typeof OBJECT_ICON_KINDS)[number];

/** Tables and views are lucide icons (#104): a grid and a framed eye. */
const LUCIDE = { table: Table, view: View } as const;

/** Our own 16 px drawings for the rest, thin monochrome strokes like the lucide icons. */
const DRAWINGS: Record<Exclude<ObjectIconKind, keyof typeof LUCIDE>, ReactNode> = {
  // The view's window, with rows kept on disk.
  materializedView: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11M5 9h6M5 11h6" />
    </>
  ),
  // A hooked f.
  function: <path d="M11 3.2c-1.4-.6-2.9 0-3.2 1.6L6.2 11.2c-.3 1.6-1.8 2.2-3.2 1.6M4.8 7h5.4" />,
  // A play button: a routine that runs.
  procedure: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M7 5.8v4.4L10.2 8z" />
    </>
  ),
};

/** Tables blue, views purple (#104), routines dimmer (tokens only, 3:1 in tokens.test.ts). */
const COLOR: Record<ObjectIconKind, string> = {
  table: "text-icon-table",
  view: "text-icon-view",
  materializedView: "text-icon-view",
  function: "text-text-2",
  procedure: "text-text-2",
};

/** The icon of a sidebar object, named for screen readers. */
export function ObjectIcon({ kind, className = "" }: { kind: ObjectIconKind; className?: string }) {
  if (kind === "table" || kind === "view") {
    const Icon = LUCIDE[kind];
    return (
      <Icon
        role="img"
        aria-label={strings.sidebar.kinds[kind]}
        data-kind={kind}
        size="1em"
        strokeWidth={1.8}
        className={`shrink-0 ${COLOR[kind]} ${className}`}
      />
    );
  }
  return (
    <svg
      role="img"
      aria-label={strings.sidebar.kinds[kind]}
      data-kind={kind}
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${COLOR[kind]} ${className}`}
    >
      {DRAWINGS[kind]}
    </svg>
  );
}
