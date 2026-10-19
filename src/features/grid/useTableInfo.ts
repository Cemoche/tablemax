import { useEffect, useState } from "react";
import { toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
import type { AppError, ObjectRef, TableInfo } from "../../lib/types";

/** The table's metadata (cached by the backend), which decides what the grid may edit. */
export function useTableInfo(workspaceId: string, object: ObjectRef) {
  const [state, setState] = useState<{ info: TableInfo | null; error: AppError | null }>({
    info: null,
    error: null,
  });
  useEffect(() => {
    let live = true;
    setState({ info: null, error: null });
    ipc.tableInfo(workspaceId, object, false).then(
      (info) => live && setState({ info, error: null }),
      (e) => live && setState({ info: null, error: toAppError(e) }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, object.schema, object.name]);
  return state;
}
