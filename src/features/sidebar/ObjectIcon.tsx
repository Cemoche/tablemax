import type { ReactNode } from "react";
import { strings } from "../../lib/strings";

export const OBJECT_ICON_KINDS = ["table", "view", "materializedView", "function", "procedure"] as const;
export type ObjectIconKind = (typeof OBJECT_ICON_KINDS)[number];

/** Our own 16 px drawings, thin monochrome strokes like the lucide icons around them. */
const DRAWINGS: Record<ObjectIconKind, ReactNode> = {
  // A grid: header row and a first column.
  table: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11M6.5 6.5V13" />
    </>
  ),
  // A window with an eye-like lens: a stored query read like a table.
  view: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11" />
      <circle cx="8" cy="9.75" r="1.6" />
    </>
  ),
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

/** Tables and views in the accent color, routines dimmer (tokens only). */
const COLOR: Record<ObjectIconKind, string> = {
  table: "text-accent",
  view: "text-accent",
  materializedView: "text-accent",
  function: "text-text-2",
  procedure: "text-text-2",
};

/** The icon of a sidebar object, named for screen readers. */
export function ObjectIcon({ kind, className = "" }: { kind: ObjectIconKind; className?: string }) {
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
