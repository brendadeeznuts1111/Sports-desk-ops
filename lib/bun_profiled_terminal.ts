/**
 * @file lib/bun_profiled_terminal.ts
 * @description Profiled terminal colour detection plus named-colour profile storage and `.env` emission.
 *
 * Colour precedence follows Bun's runtime specification: an explicit `FORCE_COLOR` wins over
 * `NO_COLOR`, and `FORCE_COLOR=0` disables colour even on a TTY.
 *
 * The emitted `.env` relies on Bun's own expansion (`PTY_ERROR=$PTY_ACCENT`), so the shared token
 * must be defined above the ones that reference it. `BUN_OPTIONS` is inherited by Bun processes
 * started in that directory; it can never change the startup flags of a process that is already
 * running, and it does not override a `BUN_OPTIONS` the parent environment already exports.
 */
import { Database } from "bun:sqlite";
import { openSportsdeskSqlite } from "./sportsdesk_sqlite.ts";

export type ColorDepth = "none" | "ansi16" | "ansi256" | "truecolor";

/**
 * Resolve the colour depth this process should emit.
 *
 * @param env - environment to read (`FORCE_COLOR`, `NO_COLOR`).
 * @param isTTY - whether stdout is a terminal; only consulted when neither variable decides.
 * @returns `none` when colour is disabled, otherwise the depth the environment asked for.
 */
export function detectColorDepth(
  env: Readonly<Record<string, string | undefined>>,
  isTTY: boolean,
): ColorDepth {
  const forceColor = env.FORCE_COLOR;
  if (forceColor !== undefined) {
    if (forceColor === "0" || forceColor === "false") return "none";
    if (forceColor === "3") return "truecolor";
    if (forceColor === "2") return "ansi256";
    return "ansi16";
  }
  if ("NO_COLOR" in env) return "none";
  return isTTY ? "ansi16" : "none";
}

export type ProfileColors = { accent: string; error: string; warn: string };

/** Profile colours that parse as a `.env` value without quoting tricks. */
const SAFE_COLOR = /^[A-Za-z0-9_#() -]+$/;

export type StoredProfile = { colors: ProfileColors; consoleDepth: number };

/**
 * Named-colour profile store backed by `bun:sqlite` (`:memory:` by default, or a file path).
 *
 * A profile is one named colour set plus the console depth its commands run at.
 */
export class NamedColorTokenStore {
  readonly #db: Database;

  constructor(path = ":memory:") {
    // House rule: SQLite opens only through lib/sportsdesk_sqlite.ts (strict + safeIntegers).
    this.#db = openSportsdeskSqlite(path);
    this.#db.run(
      `CREATE TABLE IF NOT EXISTS profiles (
        name TEXT PRIMARY KEY,
        accent TEXT NOT NULL,
        error TEXT NOT NULL,
        warn TEXT NOT NULL,
        console_depth INTEGER NOT NULL
      )`,
    );
  }

  /** Insert or replace one profile. */
  setProfile(name: string, colors: ProfileColors, consoleDepth: number): void {
    for (const [field, value] of Object.entries(colors)) {
      if (!SAFE_COLOR.test(value)) {
        throw new Error(
          `ERR_PTY_COLOR_UNSAFE: ${field} ${JSON.stringify(value)}`,
        );
      }
    }
    if (!Number.isInteger(consoleDepth) || consoleDepth < 0) {
      throw new Error(`ERR_PTY_CONSOLE_DEPTH_INVALID: ${String(consoleDepth)}`);
    }
    this.#db
      .query(
        `INSERT INTO profiles (name, accent, error, warn, console_depth) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           accent = excluded.accent, error = excluded.error,
           warn = excluded.warn, console_depth = excluded.console_depth`,
      )
      .run(name, colors.accent, colors.error, colors.warn, consoleDepth);
  }

  /** Read one profile, or `undefined` when the name is unknown. */
  getProfile(name: string): StoredProfile | undefined {
    const row = this.#db
      .query(
        "SELECT accent, error, warn, console_depth FROM profiles WHERE name = ?",
      )
      .get(name) as {
      accent: string;
      error: string;
      warn: string;
      console_depth: number;
    } | null;
    if (row === null) return undefined;
    return {
      colors: { accent: row.accent, error: row.error, warn: row.warn },
      consoleDepth: Number(row.console_depth),
    };
  }

  close(): void {
    this.#db.close();
  }
}

export type ProfileDotEnvOptions = {
  /** Reference the accent token (`$PTY_ACCENT`) instead of repeating its literal value. */
  expandSharedColors?: boolean;
  /** Emit `DO_NOT_TRACK=1` so Bun crash reports stay off in this profile. */
  disableTelemetryAndClear?: boolean;
};

/**
 * Render one stored profile as a Bun-readable `.env` file.
 *
 * Values are quoted, the accent token is defined first so Bun's own expansion can resolve the
 * others, and `BUN_OPTIONS` carries the profile's console depth.
 */
export function formatProfileDotEnv(
  store: NamedColorTokenStore,
  profile: string,
  options: ProfileDotEnvOptions = {},
): string {
  const entry = store.getProfile(profile);
  if (entry === undefined)
    throw new Error(`ERR_PTY_PROFILE_UNKNOWN: ${profile}`);
  const { colors, consoleDepth } = entry;
  const reference = (value: string): string =>
    options.expandSharedColors === true && value === colors.accent
      ? "$PTY_ACCENT"
      : `"${value}"`;
  const lines = [
    `PTY_ACCENT="${colors.accent}"`,
    `PTY_WARN=${reference(colors.warn)}`,
    `PTY_ERROR=${reference(colors.error)}`,
    `BUN_OPTIONS="--console-depth=${consoleDepth}"`,
  ];
  if (options.disableTelemetryAndClear === true) lines.push("DO_NOT_TRACK=1");
  return `${lines.join("\n")}\n`;
}

export type ThemeRole =
  | "accent"
  | "error"
  | "warn"
  | "info"
  | "muted"
  | "code"
  | "border"
  | "bg"
  | "fg";

/** `Bun.color()` output formats that produce a foreground SGR escape. */
export type AnsiFormat = "ansi-16m" | "ansi-256" | "ansi-16";

/** Map a detected depth to the `Bun.color()` format used to precompute escapes. */
export function depthToAnsiFormat(depth: ColorDepth): AnsiFormat {
  if (depth === "truecolor") return "ansi-16m";
  if (depth === "ansi256") return "ansi-256";
  return "ansi-16";
}

/** A stored colour resolved to every representation downstream consumers need. */
export type DerivedColorToken = {
  readonly role: ThemeRole;
  readonly name: string;
  readonly number: number;
  readonly hex: string;
  readonly ansiFg: string;
  readonly luminance: number;
};

/** Relative luminance (WCAG) of a 24-bit RGB integer, 0 (black) to 1 (white). */
export function colorLuminance(rgb: number): number {
  const channel = (shift: number): number => {
    const value = (((rgb >>> shift) & 0xff) / 255) as number;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

/**
 * Normalise any `Bun.ColorInput` — a CSS name, a packed 24-bit number, an `{r,g,b,a}` object, an
 * `[r,g,b(,a)]` tuple, or a typed array — to the pair the dual-token store keeps.
 *
 * `Bun.color()` accepts all of them; the store's `color_name` column is TEXT, so the canonical CSS
 * string is what gets persisted, and the packed number is what renders. A string-only signature
 * would reject every documented non-string input (and crash on `.trim()`).
 *
 * @returns `null` when Bun cannot parse the input.
 * @see https://bun.com/reference/bun/ColorInput
 */
export function parseColorInput(input: Bun.ColorInput): {
  readonly name: string;
  readonly number: number;
} | null {
  const parsed = Bun.color(input, "number");
  if (parsed === null) return null;
  const number = (parsed >>> 0) & 0xffffff;
  // A string input keeps its own spelling (`rebeccapurple`, not Bun's compressed `#639`);
  // everything else takes the canonical CSS Bun renders for it (`red`, `#ff8000`).
  const css = Bun.color(input, "css");
  const name =
    typeof input === "string" && input.trim() !== ""
      ? input.trim().toLowerCase()
      : typeof css === "string" && css !== ""
        ? css
        : `#${number.toString(16).padStart(6, "0")}`;
  return { name, number };
}

/**
 * Validate one CSS colour name through `Bun.color()` and precompute its 24-bit number,
 * hex string, foreground escape and luminance.
 * @throws ERR_COLOR_INVALID when Bun cannot parse the name.
 */
export function deriveColorToken(
  role: ThemeRole,
  colorName: Bun.ColorInput,
  format: AnsiFormat = "ansi-16m",
): DerivedColorToken {
  const token = parseColorInput(colorName);
  if (token === null) {
    throw new Error(
      `ERR_COLOR_INVALID: ${JSON.stringify(colorName)} failed Bun.color(..., "number")`,
    );
  }
  const { name, number } = token;
  return {
    role,
    name,
    number,
    hex: Bun.color(number, "hex") ?? `#${number.toString(16).padStart(6, "0")}`,
    ansiFg: Bun.color(number, format) ?? "",
    luminance: colorLuminance(number),
  };
}

/** Console-inspect settings a profile carries alongside its colours. */
export type ProfileInspectSettings = {
  readonly consoleDepth: number;
  readonly sorted: boolean;
  readonly compact: boolean;
  readonly maxArrayLength: number;
};

export type BuiltinProfile = {
  readonly colors: Partial<Record<ThemeRole, Bun.ColorInput>>;
  readonly inspect: ProfileInspectSettings;
};

/** Seed profiles written on first open; every colour is a valid CSS name. */
export const BUILTIN_PROFILES: Readonly<Record<string, BuiltinProfile>> = {
  default: {
    colors: {
      accent: "dodgerblue",
      error: "red",
      warn: "gold",
      info: "deepskyblue",
      muted: "gray",
      code: "orange",
      border: "dimgray",
      bg: "black",
      fg: "white",
    },
    inspect: {
      consoleDepth: 2,
      sorted: false,
      compact: false,
      maxArrayLength: 100,
    },
  },
  "crimson-dry": {
    colors: {
      accent: "crimson",
      error: "darkred",
      warn: "goldenrod",
      info: "dodgerblue",
      muted: "gray",
      code: "orange",
      border: "dimgray",
      bg: "whitesmoke",
      fg: "black",
    },
    inspect: {
      consoleDepth: 4,
      sorted: true,
      compact: false,
      maxArrayLength: 50,
    },
  },
  "incident-red": {
    colors: {
      accent: "red",
      error: "darkred",
      warn: "orange",
      info: "dodgerblue",
      muted: "gray",
      code: "gold",
      border: "darkred",
      bg: "black",
      fg: "white",
    },
    inspect: {
      consoleDepth: 6,
      sorted: false,
      compact: true,
      maxArrayLength: 200,
    },
  },
};
