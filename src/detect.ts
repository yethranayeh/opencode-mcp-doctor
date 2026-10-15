/* Core detection: which MCP server processes are running, and who owns them.
 *
 * The unit of interest is a "launch chain": the top-level launcher (npx, bunx, node)
 * plus every descendant that still carries the server package in its command line.
 * The process that launched that chain decides what it is for us:
 *
 *   - no parent left (reparented to launchd)  -> orphan, safe to reclaim
 *   - a live host (OpenCode, Claude, an IDE)  -> in use by that host
 */

export interface ServerTarget {
  /** Server name, as written in configuration. */
  name: string
  /** Launch command from configuration. */
  command: string[]
}

export interface PsEntry {
  pid: number
  ppid: number
  command: string
}

export type OwnerKind = "self" | "opencode" | "app" | "orphan"

export interface Instance {
  server: string
  /** Package name the chain was matched on. */
  key: string
  /** Topmost process of the chain; the one that was launched. */
  rootPid: number
  pids: number[]
  owner: OwnerKind
  ownerPid: number | null
  ownerName: string
}

/** Hosts we name explicitly instead of showing as a bare executable. */
const HOST_NAMES: Array<[RegExp, string]> = [
  [/^opencode$/, "opencode"],
  [/^claude$/, "claude"],
  [/^codex$/, "codex"],
]

/** Executables that take a package to run, so their first positional argument names the server. */
const RUNNERS = new Set(["npx", "npm", "pnpm", "yarn", "bun", "bunx", "dlx", "deno", "uv", "uvx", "pipx"])

/**
 * The searchable name of an MCP server command: its package argument when it has
 * one, otherwise the executable. `npx -y chrome-devtools-mcp@latest` -> `chrome-devtools-mcp`.
 */
export function packageKey(command: readonly string[]): string | null {
  const executable = basename(command[0] ?? "")
  if (!executable) {
    return null
  }
  const positionals = command.slice(1).filter((arg) => !arg.startsWith("-"))
  const runner = RUNNERS.has(executable)
  for (let i = positionals.length - 1; i >= 0; i--) {
    const arg = positionals[i]!
    if (!/[A-Za-z]/.test(arg)) {
      continue
    }
    if (runner || arg.includes("/") || arg.includes("-") || arg.includes(".") || arg.startsWith("@")) {
      return stripVersion(arg)
    }
  }
  return stripVersion(executable)
}

/** Drops a trailing `@version`, leaving scoped names such as `@scope/name` and paths intact. */
function stripVersion(spec: string): string {
  const at = spec.lastIndexOf("@")
  if (at <= 0) {
    return spec
  }
  const version = spec.slice(at + 1)
  if (version.includes("/")) {
    return spec
  }
  return spec.slice(0, at)
}

export function parsePs(output: string): PsEntry[] {
  const entries: PsEntry[] = []
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match) {
      entries.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] })
    }
  }
  return entries
}

/**
 * Groups matched processes into launch chains and classifies each chain.
 * `selfPid` is the process the caller runs in, so it can recognise its own chains.
 */
export function findInstances(
  targets: readonly ServerTarget[],
  entries: readonly PsEntry[],
  selfPid: number,
): Instance[] {
  const byPid = new Map<number, PsEntry>()
  const children = new Map<number, PsEntry[]>()
  for (const entry of entries) {
    byPid.set(entry.pid, entry)
    const siblings = children.get(entry.ppid)
    if (siblings) {
      siblings.push(entry)
    } else {
      children.set(entry.ppid, [entry])
    }
  }

  const instances: Instance[] = []
  const seen = new Set<number>()

  for (const target of targets) {
    const key = packageKey(target.command)
    if (!key) {
      continue
    }

    // Every matched process belongs to the chain of its topmost matching ancestor.
    const tops = new Map<number, PsEntry>()
    for (const entry of entries) {
      if (!entry.command.includes(key)) {
        continue
      }
      let top = entry
      for (;;) {
        const parent = byPid.get(top.ppid)
        if (!parent || !parent.command.includes(key)) {
          break
        }
        top = parent
      }
      tops.set(top.pid, top)
    }

    for (const top of tops.values()) {
      if (seen.has(top.pid)) {
        continue
      }
      seen.add(top.pid)

      const pids = [top.pid]
      const queue = [top.pid]
      while (queue.length > 0) {
        const pid = queue.pop()!
        for (const child of children.get(pid) ?? []) {
          if (child.command.includes(key)) {
            pids.push(child.pid)
            queue.push(child.pid)
          }
        }
      }

      const host = byPid.get(top.ppid)
      instances.push({
        server: target.name,
        key,
        rootPid: top.pid,
        pids: pids.sort((a, b) => a - b),
        ...classify(host, selfPid),
      })
    }
  }

  return instances.sort((a, b) => a.server.localeCompare(b.server) || a.rootPid - b.rootPid)
}

function classify(host: PsEntry | undefined, selfPid: number): Pick<Instance, "owner" | "ownerPid" | "ownerName"> {
  // No parent, or the parent is launchd: the launcher is gone and the chain was reparented.
  if (!host || host.pid === 1) {
    return { owner: "orphan", ownerPid: null, ownerName: "no parent" }
  }
  if (host.pid === selfPid) {
    return { owner: "self", ownerPid: host.pid, ownerName: "opencode" }
  }
  const name = basename(host.command)
  for (const [pattern, label] of HOST_NAMES) {
    if (pattern.test(name)) {
      return { owner: label === "opencode" ? "opencode" : "app", ownerPid: host.pid, ownerName: label }
    }
  }
  return { owner: "app", ownerPid: host.pid, ownerName: name }
}

function basename(command: string): string {
  const first = command.split(" ")[0] ?? command
  const parts = first.split("/")
  return parts[parts.length - 1] || first
}

/** Instances that interfere with a new one: another live process already running the same server. */
export function conflicts(instances: readonly Instance[]): Instance[] {
  return instances.filter((instance) => instance.owner === "opencode" || instance.owner === "app")
}

export function orphans(instances: readonly Instance[]): Instance[] {
  return instances.filter((instance) => instance.owner === "orphan")
}
