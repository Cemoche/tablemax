import { safeModeBannerText } from "../../lib/safeMode";
import { strings } from "../../lib/strings";
import { type LiveEnvSource, useLiveEnv } from "./useLiveEnv";
import { ENV_BG } from "./WorkspaceSwitcher";

interface Props {
  workspace: LiveEnvSource & { name: string };
}

/**
 * Thin bar at the top of a workspace: `<connection> · <TAG>` (live tag), plus the safe mode
 * the backend enforces when it matters.
 */
export function EnvBanner({ workspace }: Props) {
  const { envTag, mode } = useLiveEnv(workspace);
  // Shown for prod (even when switched off) and for any connection that confirms something.
  const showMode = envTag === "prod" || mode !== "off";
  return (
    <div
      role="status"
      aria-label={strings.safety.bannerLabel}
      className={`shrink-0 px-3 py-0.5 text-xs font-semibold text-bg ${ENV_BG[envTag]}`}
    >
      {workspace.name} · {envTag.toUpperCase()}
      {showMode && <span className="ml-3 font-normal">{strings.safety.bannerMode(safeModeBannerText(mode))}</span>}
    </div>
  );
}
