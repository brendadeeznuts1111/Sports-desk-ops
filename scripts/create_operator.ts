#!/usr/bin/env bun
/**
 * @file scripts/create_operator.ts
 * @description Secure CLI utility to create an operator in PostgreSQL with Argon2id password hashing.
 * Password is never accepted via argv or env: piped JSON or interactive TTY prompt only.
 */

import { Buffer } from "node:buffer";
import { sql } from "../lib/db.ts";
import { hashPassword } from "../lib/auth.ts";

type Role = "admin" | "operator" | "viewer";
const ROLES: readonly Role[] = ["admin", "operator", "viewer"];
const MIN_PW = 12;
const MAX_PW = 1024;

const USAGE = `Usage:
  bun scripts/create_operator.ts [options]

Options:
  --username <name>   Operator username (letters, digits, '_', '.', '-'). Prompted if omitted.
  --role <role>       One of: admin, operator, viewer. Default: operator.
  --generate          Generate a strong password, print once to stderr, store its hash.
  -h, --help          Show this help.

Password is NEVER accepted via argv or env.
  • TTY: prompted with echo disabled.
  • Piped stdin: JSON {"username","role","password"}  (or 3 lines username/role/password).
`;

const fail = (msg: string): never => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

// ── Input ────────────────────────────────────────────────────────────────────

interface ParsedArgs {
  username?: string;
  role?: Role;
  generate: boolean;
  help: boolean;
}

const parseArgs = (argv: string[]): ParsedArgs => {
  const out: ParsedArgs = { generate: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--username": {
        const next = argv[++i];
        if (next) out.username = next;
        break;
      }
      case "--role": {
        const next = argv[++i];
        if (next) out.role = next as Role;
        break;
      }
      case "--generate":
        out.generate = true;
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      default:
        if (a.startsWith("--password") || a.startsWith("-p")) {
          fail(
            "Passwords must not be supplied via argv. Use the prompt or piped stdin.",
          );
        }
        fail(`Unknown argument: ${a}`);
    }
  }
  return out;
};

const readPipedJson = async (): Promise<{
  username?: string | undefined;
  role?: Role | undefined;
  password?: string | undefined;
}> => {
  const text = await Bun.stdin.text();
  const trimmed = text.trim();
  if (!trimmed) fail("stdin was empty.");
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as {
        username?: string | undefined;
        role?: Role | undefined;
        password?: string | undefined;
      };
    } catch {
      fail("stdin looked like JSON but did not parse.");
    }
  }
  const parts = trimmed.split(/\r?\n/);
  const u = parts[0];
  const r = parts[1];
  const p = parts[2];
  return { username: u, role: r as Role | undefined, password: p };
};

const readLineTTY = async (prompt: string, masked = false): Promise<string> => {
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdout.write(prompt);
  return new Promise<string>((resolve, reject) => {
    let buf = "";
    const done = (fn: () => void) => {
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      fn();
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString()) {
        const code = ch.codePointAt(0);
        if (code === undefined) continue;
        if (ch === "\r" || ch === "\n" || code === 0x04)
          return done(() => resolve(buf));
        if (code === 0x03) return done(() => reject(new Error("aborted")));
        if (code === 0x7f || code === 0x08) {
          if (buf.length > 0) {
            buf = Array.from(buf).slice(0, -1).join("");
            if (masked) process.stdout.write("\b \b");
          }
          continue;
        }
        if (code < 0x20) continue;
        buf += ch;
        if (masked) process.stdout.write("*");
      }
    };
    process.stdin.on("data", onData);
  });
};

// ── Password generation ─────────────────────────────────────────────────────

const GENERATED_PW_LEN = 24;
const GEN_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZ" + // no I / O
  "abcdefghijkmnopqrstuvwxyz" + // no l
  "23456789" +
  "!@#$%^&*-_=+";

const generatePassword = (len = GENERATED_PW_LEN): string => {
  let out = "";
  while (out.length < len) {
    const bytes = crypto.getRandomValues(new Uint8Array(len * 2));
    for (let i = 0; i < bytes.length && out.length < len; i++) {
      const b = bytes[i]!;
      if (b < Math.floor((256 / GEN_ALPHABET.length) * GEN_ALPHABET.length)) {
        out += GEN_ALPHABET[b % GEN_ALPHABET.length];
      }
    }
  }
  return out;
};

// ── Main ────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  const isTTY = process.stdin.isTTY === true;
  let input: { username: string; role: Role; password: string };

  if (!isTTY) {
    const piped = await readPipedJson();
    input = {
      username: String(piped.username ?? ""),
      role: (piped.role ?? "operator") as Role,
      password: String(piped.password ?? ""),
    };
  } else {
    const username = args.username ?? (await readLineTTY("Username: "));
    const role = (args.role ??
      ((await readLineTTY("Role [operator/admin/viewer]: ")) ||
        "operator")) as Role;

    let password: string;
    if (args.generate) {
      password = generatePassword();
      console.error(
        `\n⚡ Generated password (shown once — copy it now):\n\n   ${password}\n`,
      );
    } else {
      password = await readLineTTY("Password: ", true);
      const confirm = await readLineTTY("Confirm password: ", true);
      if (password !== confirm) fail("Passwords do not match.");
    }
    input = { username, role, password };
  }

  // Validation
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(input.username)) {
    fail("Username must be 3–64 chars: letters, digits, '_', '.', '-'.");
  }
  if (!ROLES.includes(input.role))
    fail(`Role must be one of: ${ROLES.join(", ")}.`);
  if (input.password.length < MIN_PW)
    fail(`Password must be ≥ ${MIN_PW} characters.`);
  if (input.password.length > MAX_PW)
    fail(`Password must be ≤ ${MAX_PW} characters.`);

  // Idempotence / race: pre-check then insert, catch 23505 for the race.
  const existing = await sql<{ id: number }[]>`
    SELECT id FROM operators WHERE LOWER(username) = LOWER(${input.username}) LIMIT 1
  `;
  if (existing.length > 0) fail(`Operator "${input.username}" already exists.`);

  const hash = await hashPassword(input.password);
  try {
    await sql`
      INSERT INTO operators (username, role, password_hash)
      VALUES (${input.username}, ${input.role}, ${hash})
    `;
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === "23505") fail(`Operator "${input.username}" already exists.`);
    if (code === "42P01")
      fail("`operators` table missing. Run `bun scripts/migrate.ts` first.");
    throw err;
  }

  console.log(
    `\n✓ Created operator "${input.username}" with role "${input.role}".`,
  );
  await sql.close();
};

main().catch((err) => {
  if (err instanceof Error && err.message === "aborted") process.exit(130);
  console.error("\n✗ failed:", err);
  process.exit(1);
});
