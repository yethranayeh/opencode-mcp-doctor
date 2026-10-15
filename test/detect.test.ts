import { describe, expect, test } from "bun:test";
import type { PsEntry, ServerTarget } from "../src/detect.ts";
import { conflicts, findInstances, orphans, packageKey, parsePs } from "../src/detect.ts";

const CHROME: ServerTarget = {
  name: "chrome-devtools",
  command: [
    "npx",
    "-y",
    "chrome-devtools-mcp@latest",
    "--chrome-arg=--disable-features=MacAppCodeSignClone",
  ],
};

const PLAYWRIGHT: ServerTarget = { name: "playwright", command: ["bunx", "@playwright/mcp"] };

describe("packageKey", () => {
  test("takes the package argument and drops its version", () => {
    expect(packageKey(CHROME.command)).toBe("chrome-devtools-mcp");
  });

  test("keeps a scoped package intact", () => {
    expect(packageKey(PLAYWRIGHT.command)).toBe("@playwright/mcp");
    expect(packageKey(["npx", "-y", "@playwright/mcp@1.2.3"])).toBe("@playwright/mcp");
  });

  test("falls back to the executable", () => {
    expect(packageKey(["/usr/local/bin/my-server", "--port", "1"])).toBe("my-server");
  });
});

describe("parsePs", () => {
  test("reads pid, ppid and the full command", () => {
    const entries = parsePs(
      " 100 1 npm exec chrome-devtools-mcp\n 101   100 node build/index.js\n",
    );
    expect(entries).toEqual<PsEntry[]>([
      { pid: 100, ppid: 1, command: "npm exec chrome-devtools-mcp" },
      { pid: 101, ppid: 100, command: "node build/index.js" },
    ]);
  });

  test("ignores a header and blank lines", () => {
    expect(parsePs("  PID  PPID COMMAND\n\n")).toEqual([]);
  });
});

describe("findInstances", () => {
  // 200 launcher <- 201 server <- 202 watchdog, launched by OpenCode (10)
  // 300 launcher <- 301 server, launched by Claude (20)
  // 400 launcher <- 401 server, launcher gone
  const ps: PsEntry[] = [
    { pid: 1, ppid: 0, command: "/sbin/launchd" },
    { pid: 10, ppid: 1, command: "/usr/local/bin/opencode" },
    { pid: 20, ppid: 1, command: "claude" },
    { pid: 200, ppid: 10, command: "npm exec chrome-devtools-mcp@latest" },
    { pid: 201, ppid: 200, command: "chrome-devtools-mcp" },
    {
      pid: 202,
      ppid: 201,
      command: "node .../chrome-devtools-mcp/build/src/telemetry/watchdog/main.js",
    },
    { pid: 300, ppid: 20, command: "npm exec chrome-devtools-mcp@latest" },
    { pid: 301, ppid: 300, command: "chrome-devtools-mcp" },
    { pid: 400, ppid: 1, command: "npm exec chrome-devtools-mcp@latest" },
    { pid: 401, ppid: 400, command: "chrome-devtools-mcp" },
  ];

  test("groups each launch chain once, from its topmost process", () => {
    const instances = findInstances([CHROME], ps, 999);
    expect(instances.map((instance) => instance.rootPid)).toEqual([200, 300, 400]);
    expect(instances[0]!.pids).toEqual([200, 201, 202]);
  });

  test("names the host that owns the chain", () => {
    const instances = findInstances([CHROME], ps, 999);
    expect(instances.map((instance) => instance.owner)).toEqual(["opencode", "app", "orphan"]);
    expect(instances[1]!.ownerName).toBe("claude");
    expect(instances[1]!.ownerPid).toBe(20);
  });

  test("recognises the caller's own chain", () => {
    const instances = findInstances([CHROME], ps, 10);
    expect(instances[0]!.owner).toBe("self");
  });

  test("treats a chain launched by launchd as orphaned", () => {
    const instances = findInstances([CHROME], ps, 999);
    expect(orphans(instances).map((instance) => instance.rootPid)).toEqual([400]);
  });

  test("reports live chains of another host as conflicts", () => {
    const instances = findInstances([CHROME], ps, 10);
    expect(conflicts(instances).map((instance) => instance.rootPid)).toEqual([300]);
  });

  test("separates servers by their own package key", () => {
    const instances = findInstances([CHROME, PLAYWRIGHT], ps, 999);
    expect(instances.every((instance) => instance.key === "chrome-devtools-mcp")).toBe(true);
  });

  test("finds nothing when no process matches", () => {
    expect(findInstances([PLAYWRIGHT], ps, 999)).toEqual([]);
  });
});
