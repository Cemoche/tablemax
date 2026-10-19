import type { EnvTag } from "../../lib/types";

/** Token classes per environment tag, shared by the banner, switcher dot, border and dialogs. */
export const ENV_BG: Record<EnvTag, string> = {
  local: "bg-env-local",
  dev: "bg-env-dev",
  staging: "bg-env-staging",
  prod: "bg-env-prod",
};

export const ENV_BORDER: Record<EnvTag, string> = {
  local: "border-t-env-local",
  dev: "border-t-env-dev",
  staging: "border-t-env-staging",
  prod: "border-t-env-prod",
};
