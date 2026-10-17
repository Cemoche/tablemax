import { effectiveSafeMode } from "../../lib/safeMode";
import { strings } from "../../lib/strings";
import type { EnvTag, SafeMode } from "../../lib/types";
import { useConnections } from "../../stores/connections";
import { ENV_BG } from "./WorkspaceSwitcher";

const MODE_TEXT: Record<SafeMode, string> = {
  off: strings.safety.bannerModeOff,
  confirmWrites: strings.safety.bannerModeConfirmWrites,
  confirmAll: strings.safety.bannerModeConfirmAll,
};

interface Props {
  workspace: { connectionId: string; name: string; envTag: EnvTag };
}

/** Thin bar at the top of a workspace: `<connection> · <TAG>`, plus the safe mode when it matters. */
export function EnvBanner({ workspace }: Props) {
  const safeMode = useConnections((s) => s.items.find((c) => c.id === workspace.connectionId)?.safeMode);
  const mode = effectiveSafeMode({ envTag: workspace.envTag, safeMode });
  // Shown for prod (even when switched off) and for any connection that confirms something.
  const showMode = workspace.envTag === "prod" || mode !== "off";
  return (
    <div
      role="status"
      aria-label={strings.safety.bannerLabel}
      className={`shrink-0 px-3 py-0.5 text-xs font-semibold text-bg ${ENV_BG[workspace.envTag]}`}
    >
      {workspace.name} · {workspace.envTag.toUpperCase()}
      {showMode && <span className="ml-3 font-normal">{strings.safety.bannerMode(MODE_TEXT[mode])}</span>}
    </div>
  );
}
