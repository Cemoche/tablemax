import { Minus, Square, X } from "lucide-react";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";

/** A window command that fails (no native window in a browser preview) is cosmetic. */
const run = (call: () => Promise<void> | undefined) => () => void call()?.catch(() => {});

const button =
  "flex size-5.5 items-center justify-center rounded-full bg-pill text-icon outline-none hover:bg-seg-sel focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent";

/**
 * Minimize, maximize / restore and close for the frameless window, at the right end of
 * the toolbar. Close takes the system close path (session flush, `close_gate`).
 */
export function WindowControls() {
  return (
    <div role="group" aria-label={strings.window.controls} className="ml-1 flex shrink-0 items-center gap-1.5">
      <button type="button" aria-label={strings.window.minimize} title={strings.window.minimize} className={button} onClick={run(ipc.windowMinimize)}>
        <Minus aria-hidden size={11} strokeWidth={2} />
      </button>
      <button
        type="button"
        aria-label={strings.window.maximize}
        title={strings.window.maximize}
        className={button}
        onClick={run(ipc.windowToggleMaximize)}
      >
        <Square aria-hidden size={9} strokeWidth={2} />
      </button>
      <button type="button" aria-label={strings.window.close} title={strings.window.close} className={button} onClick={run(ipc.windowClose)}>
        <X aria-hidden size={11} strokeWidth={2} />
      </button>
    </div>
  );
}
