import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { targetsFromConfig, targetsFromFile } from "../src/config.ts";

describe("targetsFromConfig", () => {
  test("reads V2 servers under mcp.servers", () => {
    const config = {
      mcp: {
        servers: {
          "chrome-devtools": {
            type: "local",
            command: ["npx", "-y", "chrome-devtools-mcp@latest"],
          },
        },
      },
    };
    expect(targetsFromConfig(config)).toEqual([
      { name: "chrome-devtools", command: ["npx", "-y", "chrome-devtools-mcp@latest"] },
    ]);
  });

  test("reads legacy servers placed directly under mcp", () => {
    const config = { mcp: { playwright: { type: "local", command: ["bunx", "@playwright/mcp"] } } };
    expect(targetsFromConfig(config)).toEqual([
      { name: "playwright", command: ["bunx", "@playwright/mcp"] },
    ]);
  });

  test("ignores remote, disabled and malformed entries", () => {
    const config = {
      mcp: {
        servers: {
          remote: { type: "remote", url: "https://example.com/mcp" },
          off: { type: "local", command: ["npx", "a-mcp"], disabled: true },
          broken: { type: "local" },
        },
      },
    };
    expect(targetsFromConfig(config)).toEqual([]);
  });

  test("accepts any config without usable servers", () => {
    expect(targetsFromConfig({})).toEqual([]);
    expect(targetsFromConfig(null)).toEqual([]);
    expect(targetsFromConfig({ mcp: { servers: {} } })).toEqual([]);
  });
});

describe("targetsFromFile", () => {
  test("reads JSONC with comments, trailing commas and a URL value", () => {
    const directory = mkdtempSync(join(tmpdir(), "mcp-doctor-"));
    const file = join(directory, "opencode.jsonc");
    writeFileSync(
      file,
      `{
        // the schema value contains two slashes of its own
        "$schema": "https://opencode.ai/config.json",
        /* and a block comment */
        "mcp": { "servers": { "a": { "type": "local", "command": ["npx", "a-mcp"], }, }, },
      }`,
    );
    expect(targetsFromFile(file).map((target) => target.name)).toEqual(["a"]);
  });

  test("returns nothing when the file is absent", () => {
    expect(targetsFromFile(join(tmpdir(), "mcp-doctor-does-not-exist.json"))).toEqual([]);
  });
});
