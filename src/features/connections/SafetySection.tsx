import { effectiveSafeMode, safeModeLabel } from "../../lib/safeMode";
import { strings } from "../../lib/strings";
import type { EnvTag, SafeMode } from "../../lib/types";
import { fieldClass, labelClass, rowClass } from "./formStyles";

interface Props {
  value: SafeMode | null | undefined;
  envTag: EnvTag;
  onChange: (mode: SafeMode | null) => void;
}

/** Safe-mode line; "Default" (null) follows the tag and says what that means. */
export function SafetySection({ value, envTag, onChange }: Props) {
  const effective = effectiveSafeMode({ envTag, safeMode: null });
  return (
    <div data-form-row="" className={rowClass}>
      <label htmlFor="cf-safe-mode" className={labelClass}>
        {strings.safety.sectionLabel}
      </label>
      <select
        id="cf-safe-mode"
        className={fieldClass}
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
    </div>
  );
}
