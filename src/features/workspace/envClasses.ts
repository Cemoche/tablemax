import type { EnvTag } from "../../lib/types";

/** Token classes per environment tag, shared by the switcher dot and the dialogs. */
export const ENV_BG: Record<EnvTag, string> = {
  local: "bg-env-local",
  dev: "bg-env-dev",
  staging: "bg-env-staging",
  prod: "bg-env-prod",
};
