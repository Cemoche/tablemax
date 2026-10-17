import { effectiveSafeMode, safeModeLabel } from "../../lib/safeMode";
import { strings } from "../../lib/strings";
import type { EnvTag, SafeMode } from "../../lib/types";

interface Props {
  value: SafeMode | null | undefined;
  envTag: EnvTag;
  onChange: (mode: SafeMode | null) => void;
}

const field = "w-full rounded-sm border border-border bg-bg px-2 py-1";

/** Safe-mode selector; "Default" (null) follows the environment tag and says what that means. */
export function SafetySection({ value, envTag, onChange }: Props) {
  const effective = effectiveSafeMode({ envTag, safeMode: null });
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted">{strings.safety.sectionLabel}</span>
      <select
        className={field}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : (e.target.value as SafeMode))}
      >
        <option value="">{strings.safety.defaultOption(safeModeLabel(effective))}</option>
        {(["off", "confirmWrites", "confirmAll"] as const).map((m) => (
          <option key={m} value={m}>
            {safeModeLabel(m)}
          </option>
        ))}
      </select>
    </label>
  );
}
