import { strings } from "../../lib/strings";
import type { DriverKind } from "../../lib/types";

export interface DriverTileLook {
  /** Two letters drawn on the tile. */
  monogram: string;
  /** Tile colour and monogram colour (tokens `--driver-*`, ≥ 4.5:1, tokens.test.ts). */
  className: string;
}

/**
 * The engines with their own tile. Tailwind needs the literal class names, so a new engine
 * is one entry here plus its two `--driver-*` tokens; until then it gets the neutral tile.
 */
const TILES: Partial<Record<DriverKind, DriverTileLook>> = {
  postgres: { monogram: "Pg", className: "bg-driver-pg text-driver-pg-text" },
  mySql: { monogram: "My", className: "bg-driver-my text-driver-my-text" },
  mariaDb: { monogram: "Ma", className: "bg-driver-ma text-driver-ma-text" },
  sqlite: { monogram: "SL", className: "bg-driver-sl text-driver-sl-text" },
};

const NEUTRAL = "bg-driver-other text-driver-other-text";

/** Monogram and colours of `kind`'s tile; the start of the engine's name on a neutral tile otherwise. */
export function driverTile(kind: DriverKind): DriverTileLook {
  return TILES[kind] ?? { monogram: (strings.driver[kind] ?? kind).slice(0, 2), className: NEUTRAL };
}

/** The 34 px engine tile of a connection row (decorative: the row names the engine). */
export function DriverTile({ kind, className = "" }: { kind: DriverKind; className?: string }) {
  const look = driverTile(kind);
  return (
    <span
      aria-hidden="true"
      className={`flex size-8.5 shrink-0 items-center justify-center rounded-lg text-sm font-semibold select-none ${look.className} ${className}`}
    >
      {look.monogram}
    </span>
  );
}
