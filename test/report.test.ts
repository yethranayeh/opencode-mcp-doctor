import { describe, expect, test } from "bun:test";
import type { Instance } from "../src/detect.ts";
import { conflictNote, exitStatus, formatReport, notice, reclaimCommand, toJson } from "../src/report.ts";

/** A chain listed parents-first, as detection returns it. */
const orphan: Instance = {
	server: "chrome-devtools",
	key: "chrome-devtools-mcp",
	rootPid: 100,
	pids: [100, 101, 102],
	owner: "orphan",
	ownerPid: null,
	ownerName: "no parent",
};

const inUse: Instance = { ...orphan, owner: "app", ownerPid: 42, ownerName: "claude" };

const own: Instance = { ...orphan, owner: "self", ownerPid: 7, ownerName: "opencode" };

/** A live chain of a different server, to keep competition from being counted across servers. */
const otherServer: Instance = {
	...inUse,
	server: "postgres",
	key: "postgres-mcp",
	rootPid: 500,
	pids: [500],
	ownerName: "codex",
};

/** Another chain the same host launched, as a second copy of the server would appear. */
function ownedBySelf(rootPid: number, pids: number[]): Instance {
	return { ...own, rootPid, pids };
}

/** notice() text for a case that should report, so each test can assert on it directly. */
function reported(instances: readonly Instance[], platform = "linux"): string {
	const text = notice({ name: "chrome-devtools" }, instances, platform);
	expect(text).not.toBeNull();
	return text ?? "";
}

describe("reclaimCommand", () => {
	test("lists POSIX pids children first", () => {
		expect(reclaimCommand(orphan, "darwin")).toBe("kill 102 101 100");
		expect(reclaimCommand(orphan, "linux")).toBe("kill 102 101 100");
	});

	test("terminates the whole tree on Windows", () => {
		expect(reclaimCommand(orphan, "win32")).toBe("taskkill /PID 100 /T /F");
	});
});

describe("formatReport", () => {
	test("names the server, its chain and its owner", () => {
		const text = formatReport([inUse]);
		expect(text).toContain("chrome-devtools (chrome-devtools-mcp)");
		expect(text).toContain("claude pid 42");
		expect(text).toContain("pids 100,101,102");
	});

	test("offers a reclaim command for an orphaned chain only", () => {
		expect(formatReport([orphan], "linux")).toContain("kill 102 101 100");
		expect(formatReport([orphan], "win32")).toContain("taskkill /PID 100 /T /F");
		expect(formatReport([inUse], "linux")).not.toContain("kill 102 101 100");
		expect(formatReport([inUse], "win32")).not.toContain("taskkill /PID 100 /T /F");
	});
});

describe("conflictNote", () => {
	// A chain the caller's own host owns still competes with another live chain.
	test("counts a self-owned chain alongside another live chain", () => {
		const note = conflictNote([own, inUse]);
		expect(note).toContain("2 live instances of chrome-devtools are running (opencode, claude)");
	});

	test("says nothing for a single live chain or an orphan", () => {
		expect(conflictNote([inUse])).toBeNull();
		expect(conflictNote([orphan])).toBeNull();
	});

	// Two servers running one chain each are both live, but they do not contend with each other.
	test("says nothing when different servers each run one chain", () => {
		expect(conflictNote([inUse, otherServer])).toBeNull();
	});
});

describe("exitStatus", () => {
	test("succeeds when nothing is running", () => {
		expect(exitStatus([], false)).toBe(0);
		expect(exitStatus([], true)).toBe(0);
	});

	test("succeeds for a single live chain", () => {
		expect(exitStatus([inUse], false)).toBe(0);
		expect(exitStatus([inUse], true)).toBe(0);
	});

	// Competition is opt-in: the same three chains pass by default and fail under --strict.
	test("fails on three competing chains only with strict", () => {
		const chains = [own, ownedBySelf(200, [200, 201]), ownedBySelf(300, [300])];
		expect(exitStatus(chains, false)).toBe(0);
		expect(exitStatus(chains, true)).toBe(4);
	});

	test("reports an orphan even with strict", () => {
		expect(exitStatus([orphan], true)).toBe(1);
	});

	// Competition is per server: one chain each of two servers is not a conflict.
	test("does not fail two different servers that each run once", () => {
		expect(exitStatus([inUse, otherServer], true)).toBe(0);
	});

	// An orphan is actionable, so it wins over competition.
	test("prefers an orphan over competing chains with strict", () => {
		expect(exitStatus([orphan, own, ownedBySelf(200, [200])], true)).toBe(1);
	});
});

describe("notice", () => {
	test("says nothing when no chain is running", () => {
		expect(notice({ name: "chrome-devtools" }, [])).toBeNull();
	});

	test("says nothing for a single chain this host owns", () => {
		expect(notice({ name: "chrome-devtools" }, [own], "linux")).toBeNull();
	});

	// A host can spawn the same server more than once; ownership alone must not hide that.
	test("reports several chains this same host launched", () => {
		const text = reported([own, ownedBySelf(200, [200, 201]), ownedBySelf(300, [300])]);
		expect(text).toContain("3 chrome-devtools instances are already running");
		expect(text).toContain("This host (opencode) owns 3 of them.");
		expect(text).toContain("in use:   pids 100,101,102 (owned by opencode pid 7)");
		expect(text).toContain("3 live instances of chrome-devtools are running");
	});

	test("reports one chain owned by another host and names that host", () => {
		const text = reported([inUse]);
		expect(text).toContain("1 chrome-devtools instance is already running");
		expect(text).toContain("owned by claude pid 42");
		expect(text).not.toContain("This host");
	});

	test("reports an orphan with the reclaim command for a fixed platform", () => {
		expect(reported([orphan], "linux")).toContain("orphaned: pids 100,101,102");
		expect(reported([orphan], "linux")).toContain("reclaim with `kill 102 101 100`");
		expect(reported([orphan], "win32")).toContain("reclaim with `taskkill /PID 100 /T /F`");
	});
});

describe("toJson", () => {
	test("lists pids in ascending order", () => {
		const parsed = JSON.parse(toJson([{ ...orphan, pids: [100, 102, 101] }]));
		expect(parsed[0].pids).toEqual([100, 101, 102]);
		expect(parsed[0].owner).toBe("orphan");
	});
});
