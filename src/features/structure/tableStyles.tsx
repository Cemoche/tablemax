/** The read-only tables of the Structure and Index views. */
export const th = "border-b border-border px-2 py-1 text-left font-medium text-muted";
export const td = "border-b border-border px-2 py-1 align-top";
export const badge = "rounded-sm border border-border bg-surface-2 px-1 text-xs text-muted";

export function Empty({ text }: { text: string }) {
  return <p className="p-3 text-muted">{text}</p>;
}
