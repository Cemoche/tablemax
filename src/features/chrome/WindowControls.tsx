import { Copy, Minus, Square, X } from "lucide-react";
import * as ipc from "../../lib/ipc";
import { isWindows } from "../../lib/platform";
import { strings } from "../../lib/strings";
import { tip } from "../../lib/tooltip";
import { useChrome } from "../../stores/chrome";
import { toggleMaximize } from "./windowState";

/** A window command that fails (no native window in a browser preview) is cosmetic. */
const run = (call: () => Promise<void> | undefined) => () => void call()?.catch(() => {});

const focusRing = "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent";

/**
 * The look of each platform (#104):
 * - Windows: flat caption buttons 46 px wide over the bar's full height, thin glyphs; close
 *   turns red with a white glyph on hover.
 * - Elsewhere (Linux, and macOS until it gets its own buttons): GNOME / libadwaita buttons,
 *   24 px circles with 16 px symbolic glyphs. GNOME never turns close red, so neither do we.
 */
const STYLES = {
  windows: {
    group: "-mr-2.5 ml-1 flex shrink-0 self-stretch",
    button: `flex w-11.5 self-stretch items-center justify-center text-icon hover:bg-seg-sel ${focusRing} focus-visible:-outline-offset-2`,
    close: "hover:bg-window-close hover:text-window-close-text",
    glyph: { size: 15, strokeWidth: 1.25 },
  },
  linux: {
    group: "ml-1 flex shrink-0 items-center gap-2.5",
    button: `flex size-6 items-center justify-center rounded-full bg-pill text-icon hover:bg-seg-sel ${focusRing}`,
    close: "",
    glyph: { size: 16, strokeWidth: 2 },
  },
} as const;

/**
 * Minimize, maximize / restore (labelled Restore while maximized) and close for the
 * frameless window, at the right end of the toolbar, in the platform's style. Close takes
 * the system close path (session flush, `close_gate`).
 */
export function WindowControls() {
  const maximized = useChrome((s) => s.maximized);
  const kind = isWindows() ? "windows" : "linux";
  const style = STYLES[kind];
  const maximizeLabel = maximized ? strings.window.restore : strings.window.maximize;
  // Windows draws its squares smaller than its dash and cross.
  const square = kind === "windows" ? { ...style.glyph, size: 13 } : { ...style.glyph, size: 14 };
  return (
    <div role="group" aria-label={strings.window.controls} data-window-style={kind} className={style.group}>
      <button type="button" aria-label={strings.window.minimize} {...tip(strings.window.minimize)} className={style.button} onClick={run(ipc.windowMinimize)}>
        <Minus aria-hidden {...style.glyph} />
      </button>
      <button type="button" aria-label={maximizeLabel} {...tip(maximizeLabel)} className={style.button} onClick={toggleMaximize}>
        {maximized ? <Copy aria-hidden {...square} /> : <Square aria-hidden {...square} />}
      </button>
      <button
        type="button"
        aria-label={strings.window.close}
        {...tip(strings.window.close)}
        className={`${style.button} ${style.close}`}
        onClick={run(ipc.windowClose)}
      >
        <X aria-hidden {...style.glyph} />
      </button>
    </div>
  );
}
