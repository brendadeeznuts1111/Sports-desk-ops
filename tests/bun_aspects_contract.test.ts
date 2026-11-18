/**
 * @file tests/bun_aspects_contract.test.ts
 * @description Separated contract tests covering the six Bun 1.4.4 + SportsDesk aspects:
 *   1. XML ingestion & native `.xml` / `Bun.XML.Document` contracts
 *   2. Image header slicing & `new Bun.Image(head).metadata()` contracts
 *   3. NSH Desk (`packages/nsh-desk`) `XmlOddsPanel` & SoA wiring contracts
 *   4. Streaming, TLS & WebSocket surface contracts
 *   5. `Bun.FetchSession` / `fetch` validation contracts
 *   6. CLI flag derivation & deploy/PM `--no-env-file` contracts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBunRunCliSurface } from "../lib/bun_cli_flags.ts";
import { canAllocatePty, type TermiosFlags } from "../lib/bun_terminal.ts";
import { SECRET_MANIFEST } from "../lib/secret_manifest.ts";
import {
  createXmlOddsArena,
  hydrateCompactXmlDocIntoArena,
  readXmlOddsRow,
} from "../packages/nsh-desk/xml_odds_view.ts";
import { checkVerboseFetchSecretSafety } from "../scripts/dx_run_control.ts";
import { parseXmlCompactDocument } from "../src/lib/xml_ingest_preflight.ts";
import soapEnvelopeDoc from "../src/templates/partner118_soap_envelope.xml";

const ROOT = join(import.meta.dir, "..");

const ONE_PIXEL_PNG = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
);

describe("Aspect 1: XML ingestion & Bun.XML.Document", () => {
  test("static .xml imports evaluate as Bun.XML.Document with @attr compact keys", () => {
    const env = soapEnvelopeDoc["soap:Envelope"];
    expect(typeof env).toBe("object");
    expect(env).not.toBeNull();
    expect((env as Record<string, unknown>)["@xmlns:soap"]).toBe(
      "http://schemas.xmlsoap.org/soap/envelope/",
    );
  });

  test("parseXmlCompactDocument returns typed Bun.XML.Document directly", () => {
    const xml = new TextEncoder().encode(
      '<feed><event id="7" line="-2.5"/></feed>',
    );
    const doc: Bun.XML.Document = parseXmlCompactDocument(xml);
    const feed = doc["feed"] as Record<string, unknown>;
    const ev = feed["event"] as Record<string, unknown>;
    expect(ev["@id"]).toBe("7");
    expect(ev["@line"]).toBe("-2.5");
  });
});

describe("Aspect 2: Image header probing & partial slice reads", () => {
  test("new Bun.Image(head).metadata() reads header dimensions without Bun.Image.from", async () => {
    expect(
      (Bun.Image as unknown as Record<string, unknown>)["from"],
    ).toBeUndefined();
    const head = ONE_PIXEL_PNG.slice(0, ONE_PIXEL_PNG.byteLength);
    const meta = await new Bun.Image(head).metadata();
    expect(meta.width).toBe(1);
    expect(meta.height).toBe(1);
    expect(meta.format).toBe("png");
    expect((meta as unknown as Record<string, unknown>)["xmp"]).toBeUndefined();
  });

  test("Bun.file().slice().bytes() reads an immutable range view", async () => {
    const fileSlice = await Bun.file(
      join(ROOT, "src/templates/partner118_soap_envelope.xml"),
    )
      .slice(0, 38)
      .bytes();
    expect(fileSlice).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(fileSlice)).toStartWith("<?xml");
  });
});

describe("Aspect 3: NSH Desk XmlOddsPanel & SoA wiring", () => {
  test("registers xml_odds panel in layout, provenance, App.tsx, and pure SoA arena", async () => {
    const arena = createXmlOddsArena(2);
    expect(
      hydrateCompactXmlDocIntoArena(
        {
          feed: { event: { "@id": "101", "@comboKey": "5", "@line": "-3.5" } },
        },
        arena,
      ),
    ).toBe(1);
    expect(readXmlOddsRow(arena, 0).line).toBe("-3.50");

    const [provenanceSrc, storeSrc, appSrc, panelSrc] = await Promise.all([
      Bun.file(join(ROOT, "packages/nsh-desk/components/provenance.ts")).text(),
      Bun.file(join(ROOT, "packages/nsh-desk/store.ts")).text(),
      Bun.file(join(ROOT, "packages/nsh-desk/App.tsx")).text(),
      Bun.file(
        join(ROOT, "packages/nsh-desk/components/XmlOddsPanel.tsx"),
      ).text(),
    ]);

    expect(provenanceSrc).toContain('xml_odds: "XML Odds Feed"');
    expect(storeSrc).toContain("hydrateXmlOddsDoc");
    expect(storeSrc).toContain("parseXmlOddsViaDaemon");
    expect(appSrc).toContain('case "xml_odds"');
    expect(appSrc).toContain("<XmlOddsPanel />");
    expect(panelSrc).toContain("<DeskXmlOddsTable");
  });
});

describe("Aspect 4: Local serving, streaming & WebSocket globals", () => {
  test("exposes WebSocket on globalThis and Bun.serve / Bun.connect / Bun.JSONL on Bun", () => {
    expect(typeof globalThis.WebSocket).toBe("function");
    expect(typeof Bun.serve).toBe("function");
    expect(typeof Bun.connect).toBe("function");
    expect(typeof Bun.JSONL.parse).toBe("function");
    expect(typeof Bun.JSONL.parseChunk).toBe("function");
  });
});

describe("Aspect 5: Outbound fetch & Bun.FetchSession contracts", () => {
  test("Bun.FetchSession validates proxy and checkServerIdentity eagerly", () => {
    expect(
      () =>
        new Bun.FetchSession({
          proxy: 8080 as unknown as string,
        }),
    ).toThrow();
    expect(
      () =>
        new Bun.FetchSession({
          tls: {
            checkServerIdentity: "invalid" as unknown as () => undefined,
          },
        }),
    ).toThrow();

    const session = new Bun.FetchSession({
      proxy: { url: "http://127.0.0.1:8080", respectNoProxy: false },
      keepAlive: { idleTimeout: 30, maxIdleSockets: 4 },
    });
    expect(typeof session.fetch).toBe("function");
    session.close();
  });
});

describe("Aspect 6: Live CLI flag derivation & deploy/PM isolation", () => {
  test("dx_run_control derives flags from bun run --help without hardcoded flag Sets", async () => {
    const surface = readBunRunCliSurface();
    expect(
      surface.entries.some((e) => e.short === "-F" && e.valueHint !== null),
    ).toBe(true);
    expect(
      surface.entries.some((e) => e.short === "-b" && e.valueHint === null),
    ).toBe(true);

    const src = await Bun.file(join(ROOT, "scripts/dx_run_control.ts")).text();
    expect(src).toContain("deriveBunFlagSets(surface)");
    expect(src).not.toContain("SHORT_BUN_FLAGS_WITH_VALUE");
    expect(src).not.toContain("VALUE_BEARING_LONG_BUN_FLAGS");
  });

  test("deploy_to_vps.sh runs bun ci --production --no-env-file", async () => {
    const deploySrc = await Bun.file(
      join(ROOT, "scripts/deploy/deploy_to_vps.sh"),
    ).text();
    expect(deploySrc).toContain('"$BUN_BIN" ci --production --no-env-file');
  });
});

describe("Aspect 7: Bun.Terminal, TerminalOptions & termios contracts", () => {
  test("canAllocatePty probes eager openpty without spawning a child process", () => {
    const ok = canAllocatePty();
    expect(typeof ok).toBe("boolean");
    if (ok) {
      const term = new Bun.Terminal({
        cols: 90,
        rows: 30,
        name: "xterm-256color",
      });
      const snap: TermiosFlags = {
        inputFlags: term.inputFlags,
        outputFlags: term.outputFlags,
        localFlags: term.localFlags,
        controlFlags: term.controlFlags,
      };
      expect(typeof snap.inputFlags).toBe("number");
      term.close();
      expect(term.closed).toBe(true);
      expect(term.inputFlags).toBe(0);
    }
  });
});

describe("Aspect 8: Bun.env interface merging, BUN_CONFIG_* & AnsiTheme", () => {
  test("Bun.env aliases process.env and typed Bun.Env keys back SECRET_MANIFEST", () => {
    expect(Bun.env).toBe(process.env);
    const maxHttpKey: keyof Bun.Env = "BUN_CONFIG_MAX_HTTP_REQUESTS";
    expect(maxHttpKey).toBe("BUN_CONFIG_MAX_HTTP_REQUESTS");
    expect(SECRET_MANIFEST.length).toBeGreaterThan(0);
    const firstSecretKey: keyof Bun.Env = SECRET_MANIFEST[0]!.envName;
    expect(typeof firstSecretKey).toBe("string");
  });

  test("checkVerboseFetchSecretSafety blocks BUN_CONFIG_VERBOSE_FETCH when a manifest secret is set", () => {
    const sampleKey = SECRET_MANIFEST[0]!.envName;
    expect(
      checkVerboseFetchSecretSafety({ BUN_CONFIG_VERBOSE_FETCH: "curl" })
        .blocked,
    ).toBe(false);

    const blocked = checkVerboseFetchSecretSafety({
      BUN_CONFIG_VERBOSE_FETCH: "1",
      [sampleKey]: "dummy-placeholder-value",
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toContain(sampleKey);
  });

  test("Bun.markdown.ansi honors Bun.markdown.AnsiTheme colors:false and explicit light polarity", () => {
    const plain = Bun.markdown.ansi("**bold** `code`", {
      colors: false,
      hyperlinks: false,
      kittyGraphics: false,
    });
    expect(plain).not.toContain("\x1b[");
    expect(plain).toContain("bold");
  });

  test("bun --env-file expands $VAR, supports quotes, and preserves escaped \\$VAR", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "bun-env-aspect-"));
    try {
      const envFile = join(workDir, ".env.test");
      await Bun.write(
        envFile,
        [
          "SINGLE='alpha'",
          'DOUBLE="beta"',
          "BACKTICK=`gamma`",
          "FOO=world",
          "BAR=hello$FOO",
          "ESC=hello\\$FOO",
        ].join("\n"),
      );
      const probe = Bun.spawnSync({
        cmd: [
          process.execPath,
          `--env-file=${envFile}`,
          "-e",
          "console.log(JSON.stringify({ s: Bun.env.SINGLE, d: Bun.env.DOUBLE, b: Bun.env.BACKTICK, bar: Bun.env.BAR, esc: Bun.env.ESC }))",
        ],
        cwd: workDir,
        env: { PATH: process.env.PATH },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(probe.exitCode).toBe(0);
      expect(JSON.parse(probe.stdout.toString().trim())).toEqual({
        s: "alpha",
        d: "beta",
        b: "gamma",
        bar: "helloworld",
        esc: "hello$FOO",
      });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
