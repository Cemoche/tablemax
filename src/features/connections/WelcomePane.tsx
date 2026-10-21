import { FileDown, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import appMark from "../../../assets/icon/tablemax.svg";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import { tip } from "../../lib/tooltip";

interface Props {
  /** Create connection…: the empty form. */
  onCreate: () => void;
  /** Import connections…: the TablePlus export import. */
  onImport: () => void;
}

const action =
  "flex h-8 w-full items-center gap-2 rounded-md px-3 text-left text-text outline-none hover:bg-seg-sel focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent";

/**
 * The left pane of the connections screen (spec §2.4): the app's own mark, name and version,
 * then its actions. Open SQLite file… is not there: the app has no SQLite file picker yet
 * (a SQLite connection is created in the form, with the file path).
 */
export function WelcomePane({ onCreate, onImport }: Props) {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    ipc
      .appVersion()
      .then((v) => live && setVersion(v))
      .catch(() => {}); // the version line is just left out
    return () => {
      live = false;
    };
  }, []);

  return (
    <section
      aria-label={strings.connections.welcomeLabel}
      className="flex w-65 shrink-0 flex-col border-r border-sep bg-side px-4 py-8"
    >
      <div className="flex flex-col items-center gap-2 pb-8">
        <img src={appMark} alt="" draggable={false} className="size-20 select-none" />
        <h1 className="text-lg font-semibold text-text">{strings.appName}</h1>
        {version && <p className="text-sm text-text-2">{strings.connections.version(version)}</p>}
      </div>
      <div className="flex flex-col gap-1">
        <button type="button" className={action} onClick={onCreate}>
          <Plus aria-hidden className="size-4 shrink-0 text-icon" />
          {strings.connections.create}
        </button>
        <button type="button" className={action} onClick={onImport} {...tip(strings.connections.importHint)}>
          <FileDown aria-hidden className="size-4 shrink-0 text-icon" />
          {strings.connections.importConnections}
        </button>
      </div>
    </section>
  );
}
