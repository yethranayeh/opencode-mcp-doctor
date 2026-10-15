#!/usr/bin/env node
/* CLI: report local MCP server processes that are leftover or competing.
 *
 * Exit codes: 0 nothing to reclaim, 1 orphaned processes found, 2 usage error.
 */

import { readTargets } from "../src/config.ts"
import { findInstances } from "../src/detect.ts"
import { conflictNote, formatReport, toJson } from "../src/report.ts"
import { psSnapshot, selfPid } from "../src/system.ts"

const USAGE = `Usage: mcp-doctor [options]

Reports the running local MCP server processes behind your configured servers, and
whether each one is still owned by a live host or was left behind.

Options:
  --config <path>  Read server commands from this config file (repeatable).
  --json           Print machine-readable output.
  --quiet          Print nothing; use the exit code only.
  -h, --help       Show this help.`

function main(argv: readonly string[]): number {
  const configs: string[] = []
  let json = false
  let quiet = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--json") {
      json = true
    } else if (arg === "--quiet") {
      quiet = true
    } else if (arg === "--config") {
      const path = argv[++i]
      if (!path) {
        process.stderr.write("mcp-doctor: --config needs a path\n")
        return 2
      }
      configs.push(path)
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${USAGE}\n`)
      return 0
    } else {
      process.stderr.write(`mcp-doctor: unknown argument ${arg}\n`)
      return 2
    }
  }

  const targets = readTargets(configs.length > 0 ? configs : undefined)
  const instances = findInstances(targets, psSnapshot(), selfPid())
  const leftover = instances.filter((instance) => instance.owner === "orphan")

  if (!quiet) {
    process.stdout.write(json ? `${toJson(instances)}\n` : `${formatReport(instances)}\n`)
    const note = conflictNote(instances)
    if (note && !json) {
      process.stdout.write(`\n${note}\n`)
    }
  }

  return leftover.length > 0 ? 1 : 0
}

process.exit(main(process.argv.slice(2)))
