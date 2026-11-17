import type { FileURL } from "./urls.ts";
import { asFileURL } from "./urls.ts";
import { createSourceLocationUrl } from "../src/lib/source_location_url.ts";
import { osc8Link } from "../src/lib/terminal_links.ts";
import {
  SchemaBrandError,
  type SchemaBrandKind,
} from "./schema_brand_error.ts";
import { SchemaUnknownTableError } from "./schema_unknown_table_error.ts";
import { SchemaValidationError } from "./schema_validation_error.ts";

export function ssotFileUrl(): FileURL {
  return asFileURL(
    new URL("./sqlite_schema_ssot.ts", import.meta.url) as URL & {
      protocol: "file:";
    },
  );
}

export function registryFileUrl(): FileURL {
  return asFileURL(
    new URL("./sqlite_schema_registry.ts", import.meta.url) as URL & {
      protocol: "file:";
    },
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 1-based line number for editor jump. */
export function findColumnLine(source: string, columnName: string): number {
  const lines = source.split("\n");
  const colRe = new RegExp(`^\\s+${escapeRegExp(columnName)}:\\s*\\{`);
  for (let i = 0; i < lines.length; i++) {
    if (colRe.test(lines[i]!)) return i + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(`"${columnName}"`)) return i + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(columnName)) return i + 1;
  }
  return 1;
}

export function findTableLine(source: string, tableName: string): number {
  const lines = source.split("\n");
  const keyRe = new RegExp(`^\\s+${escapeRegExp(tableName)}:\\s*\\{`);
  for (let i = 0; i < lines.length; i++) {
    if (keyRe.test(lines[i]!)) return i + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(`"${tableName}"`)) return i + 1;
  }
  return 1;
}

type JumpBase = { fileUrl: FileURL; line: number; editorColumn: number };

export type SchemaErrorJump =
  | (JumpBase & {
      tag: "brand";
      kind: SchemaBrandKind;
      identifier: string;
    })
  | (JumpBase & { tag: "unknown_table"; table: string })
  | (JumpBase & {
      tag: "validation";
      table: string;
      columnName: string;
      keyName: string;
    })
  | (JumpBase & { tag: "fallback" });

function brandFileUrl(kind: SchemaBrandKind): FileURL {
  return kind === "domain" ? registryFileUrl() : ssotFileUrl();
}

export function parseSchemaErrorTarget(err: unknown): SchemaErrorJump | null {
  if (err instanceof SchemaBrandError) {
    return {
      tag: "brand",
      fileUrl: brandFileUrl(err.kind),
      line: 1,
      editorColumn: 1,
      kind: err.kind,
      identifier: err.identifier,
    };
  }
  if (err instanceof SchemaUnknownTableError) {
    return {
      tag: "unknown_table",
      fileUrl: ssotFileUrl(),
      line: 1,
      editorColumn: 1,
      table: err.table,
    };
  }
  if (err instanceof SchemaValidationError) {
    const miss = err.firstKeyUnknownColumn();
    if (miss) {
      return {
        tag: "validation",
        fileUrl: registryFileUrl(),
        line: 1,
        editorColumn: 1,
        table: miss.table,
        columnName: miss.column,
        keyName: miss.keyName,
      };
    }
  }
  return null;
}

export async function resolveSchemaErrorJump(
  target: SchemaErrorJump,
): Promise<SchemaErrorJump> {
  const text = await Bun.file(Bun.fileURLToPath(target.fileUrl)).text();
  switch (target.tag) {
    case "brand":
      if (target.kind === "column" || target.kind === "index") {
        return {
          ...target,
          line: findColumnLine(text, target.identifier),
          editorColumn: 1,
        };
      }
      if (target.kind === "table") {
        return {
          ...target,
          line: findTableLine(text, target.identifier),
          editorColumn: 1,
        };
      }
      return target;
    case "unknown_table":
      return {
        ...target,
        line: findTableLine(text, target.table),
        editorColumn: 1,
      };
    case "validation":
      return {
        ...target,
        line: findColumnLine(text, target.columnName),
        editorColumn: 1,
      };
    case "fallback":
      return target;
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

function jumpHint(jump: SchemaErrorJump): string {
  switch (jump.tag) {
    case "brand":
      return `  → ${jump.kind} "${jump.identifier}" (use --open to jump)`;
    case "unknown_table":
      return `  → table "${jump.table}" (use --open to jump)`;
    case "validation":
      return `  → validation column "${jump.columnName}" on ${jump.table} (use --open to jump)`;
    case "fallback":
      return "  → registry source (use --open to jump)";
    default: {
      const _exhaustive: never = jump;
      return _exhaustive;
    }
  }
}

function ansi(text: string, ...codes: number[]): string {
  if (!process.stderr.isTTY) return text;
  return `\x1b[${codes.join(";")}m${text}\x1b[0m`;
}

export function formatSchemaError(err: Error): string {
  const head = ansi("schema error:", 1, 31);
  const body = ansi(err.message, 31);
  const jump = parseSchemaErrorTarget(err);
  const hint = jump ? ansi(jumpHint(jump), 33) : "";
  return [head, body, hint].filter(Boolean).join("\n");
}

export function openAt(fileUrl: FileURL, line: number, column: number): void {
  const resolved =
    Bun.env.VISUAL?.trim() ||
    Bun.env.EDITOR?.trim() ||
    (Bun.which("code") ? "vscode" : undefined);

  try {
    const path = Bun.fileURLToPath(fileUrl);
    if (resolved === "vscode" || resolved === "subl") {
      Bun.openInEditor(path, { line, column, editor: resolved });
      return;
    }
    if (resolved?.includes("code")) {
      Bun.openInEditor(path, { line, column, editor: "vscode" });
      return;
    }
    if (resolved?.includes("subl")) {
      Bun.openInEditor(path, { line, column, editor: "subl" });
      return;
    }
    Bun.openInEditor(path, { line, column });
  } catch {
    // CI / headless — no editor available
  }
}

export function formatSchemaJumpLink(jump: SchemaErrorJump): string {
  const locationUrl = createSourceLocationUrl(
    Bun.fileURLToPath(jump.fileUrl),
    jump.line,
    jump.editorColumn,
  );
  const label = `${Bun.fileURLToPath(jump.fileUrl)}:${jump.line}:${jump.editorColumn}`;
  return osc8Link(locationUrl, label);
}

export async function maybeOpenSchemaError(
  err: unknown,
  open: boolean,
  fallbackFileUrl?: FileURL,
): Promise<void> {
  if (!open) return;

  let target = parseSchemaErrorTarget(err);
  if (!target && fallbackFileUrl) {
    target = {
      tag: "fallback",
      fileUrl: fallbackFileUrl,
      line: 1,
      editorColumn: 1,
    };
  }
  if (!target) return;

  const resolved = await resolveSchemaErrorJump(target);
  openAt(resolved.fileUrl, resolved.line, resolved.editorColumn);
}
