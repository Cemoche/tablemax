import { strings } from "../../lib/strings";
import type { Dialect, ObjectRef, ResultSet, TableInfo } from "../../lib/types";
import type { GridModel } from "./editModel";
import { type FkLink, fkLinksAt } from "./fkLinks";
import type { MenuItem } from "./GridContextMenu";
import { openReferenced } from "./tableNavigation";

interface Args {
  workspaceId: string;
  tabId: string;
  object: ObjectRef;
  dialect: Dialect;
  info: TableInfo | null;
  data: ResultSet | null;
  model: GridModel | null;
}

/**
 * The foreign key links of the grid's cells (loaded rows only: a new row references
 * nothing yet) and opening them in the same tab.
 */
export function useFkLinks({ workspaceId, tabId, object, dialect, info, data, model }: Args) {
  const linksAt = (row: number, col: number): FkLink[] => {
    const r = model?.rows[row];
    const name = model?.columns[col];
    if (!info || !data || !model || r?.kind !== "row" || name === undefined) return [];
    return fkLinksAt(info, dialect, model.columns, data.rows[r.index], name);
  };

  /** False when refused (changes pending: the tab says so). */
  const open = (link: FkLink) => openReferenced(workspaceId, tabId, object, link.object, link.filters);

  /** "Open referenced row", one entry per referenced table when the column is in several keys. */
  const menuItems = (row: number, col: number | null): MenuItem[] => {
    if (col === null) return [];
    const links = linksAt(row, col);
    return links.map((l) => ({
      label: links.length === 1 ? strings.grid.menu.openReferenced : strings.grid.openReferencedIn(l.object.name),
      onSelect: () => void open(l),
    }));
  };

  return { linksAt, open, menuItems };
}
