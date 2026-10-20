import { Copy, Minus, Square, X } from "lucide-react";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import { tip } from "../../lib/tooltip";
import { useChrome } from "../../stores/chrome";
import { toggleMaximize } from "./windowState";

/** A window command that fails (no native window in a browser preview) is cosmetic. */
const run = (call: () => Promise<void> | undefined) => () => void call()?.catch(() => {});

const button =
  "flex size-5.5 items-center justify-center rounded-full bg-pill text-icon outline-none hover:bg-seg-sel focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent";

/**
 * Minimize, maximize / restore (labelled Restore while maximized) and close for the
 * frameless window, at the right end of the toolbar. Close takes the system close path (session flush, `close_gate`).
 */
export function WindowControls() {
  const maximized = useChrome((s) => s.maximized);
  const maximizeLabel = maximized ? strings.window.restore : strings.window.maximize;
  return (
    <div role="group" aria-label={strings.window.controls} className="ml-1 flex shrink-0 items-center gap-1.5">
      <button type="button" aria-label={strings.window.minimize} {...tip(strings.window.minimize)} className={button} onClick={run(ipc.windowMinimize)}>
        <Minus aria-hidden size={11} strokeWidth={2} />
      </button>
      <button
        type="button"
        aria-label={maximizeLabel}
        {...tip(maximizeLabel)}
        className={button}
        onClick={toggleMaximize}
      >
        {maximized ? <Copy aria-hidden size={10} strokeWidth={2} /> : <Square aria-hidden size={9} strokeWidth={2} />}
      </button>
      <button type="button" aria-label={strings.window.close} {...tip(strings.window.close)} className={button} onClick={run(ipc.windowClose)}>
        <X aria-hidden size={11} strokeWidth={2} />
      </button>
    </div>
  );
}
