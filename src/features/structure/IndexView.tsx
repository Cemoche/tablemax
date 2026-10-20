import { useCallback, useEffect, useRef, useState } from "react";
import { toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { AppError, ObjectRef, TableInfo } from "../../lib/types";
import { indexDetails } from "./indexDetails";
import { Empty, badge, td, th } from "./tableStyles";

const s = strings.structure;
const HEADERS = ["name", "columns", "unique", "type", "condition"] as const;

/**
 * The Index view of a table tab: one row per index with its name (and a primary badge),
 * columns, uniqueness, access method and partial condition. It reads the same cached table
 * info as the structure and the grid (no other backend call); Refresh reads it again.
 */
export function IndexView({ workspaceId, object }: { workspaceId: string; object: ObjectRef }) {
  const [state, setState] = useState<{ info: TableInfo | null; error: AppError | null }>({ info: null, error: null });
  const [pending, setPending] = useState(true);
  const run = useRef(0);

  const load = useCallback(
    (refresh: boolean) => {
      // The newest load wins: an older answer arriving late is dropped.
      const id = ++run.current;
      setPending(true);
      ipc.tableInfo(workspaceId, object, refresh).then(
        (info) => id === run.current && (setState({ info, error: null }), setPending(false)),
        (e) => id === run.current && (setState({ info: null, error: toAppError(e) }), setPending(false)),
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceId, object.schema, object.name],
  );

  useEffect(() => {
    setState({ info: null, error: null });
    load(false);
    return () => {
      run.current++;
    };
  }, [load]);

  const body = () => {
    if (state.error) return <p role="alert" className="p-3 text-danger">{s.loadFailed(state.error.message)}</p>;
    if (!state.info) return <Empty text={s.loading} />;
    if (state.info.indexes.length === 0) return <Empty text={s.noIndexes} />;
    return (
      <table aria-label={s.indexView.label} className="w-full border-collapse">
        <thead>
          <tr>
            {HEADERS.map((k) => (
              <th key={k} scope="col" className={th}>
                {s.indexView.headers[k]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {state.info.indexes.map((i, n) => {
            const d = indexDetails(i.definition);
            return (
              <tr key={`${i.name}#${n}`}>
                <td className={td}>
                  <span className="flex items-center gap-1">
                    {i.name}
                    {i.primary && <span className={badge}>{s.primary}</span>}
                  </span>
                </td>
                <td className={td}>{i.columns.join(", ")}</td>
                <td className={td}>{i.unique ? s.yes : s.no}</td>
                <td className={`${td} font-mono`}>{d.type}</td>
                <td className={`${td} font-mono`}>{d.condition}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  };

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <div className="flex items-center justify-end border-b border-border px-2 py-1">
        <button
          type="button"
          aria-busy={pending}
          onClick={() => load(true)}
          className="rounded-sm border border-border px-2 py-1 outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent"
        >
          {s.refresh}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{body()}</div>
    </div>
  );
}
