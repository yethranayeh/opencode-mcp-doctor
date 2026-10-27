# opencode-mcp-doctor

Find leftover and competing local MCP server processes behind your OpenCode servers.

An MCP server added under `mcp.servers` is a child process of the host that launched it.
Two things go wrong with those processes:

- **Leftovers.** The launcher exits without its children, so a process stays behind holding
  whatever the server holds.
- **Competition.** A second instance starts while an earlier one is still running, and the
  two fight over shared resources.

It was written mainly for `chrome-devtools-mcp`, where instances share one Chrome profile by default, so a second one fails with `browser is already running`. The check itself covers every local server in your configuration.

Two pieces:

| Piece        | What it does                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `mcp-doctor` | CLI. Lists the running processes behind your servers and says who owns each one.                                             |
| Plugin       | Checks once per session, on the first call to a local server's tool, and adds a note when it finds leftover or competing chains, including several from this host. |

Neither piece kills a process or writes to your configuration. It only reports and leaves the decision to you.

## Install

The plugin is picked up automatically from OpenCode's plugin directory:

```sh
git clone https://github.com/yethranayeh/opencode-mcp-doctor \
  ~/.config/opencode/plugins/opencode-mcp-doctor
```

The same path works on Windows, where it resolves to `%USERPROFILE%\.config\opencode\plugins\opencode-mcp-doctor`.

Alternatively, point at the checkout from `opencode.json`:

```jsonc
{
	"$schema": "https://opencode.ai/config.json",
	"plugins": ["/absolute/path/to/opencode-mcp-doctor"]
}
```

Restart the background service after installing, so the new plugin loads:

```sh
opencode service restart
```

The CLI needs no install, so you can run it from the checkout or through `bunx` once the package is published:

```sh
bun bin/mcp-doctor.ts
```

## Usage

```text
mcp-doctor [options]

  --config <path>  Read server commands from this config file (repeatable).
  --json           Print machine-readable output.
  --quiet          Print nothing; use the exit code only.
  --strict         Fail when more than one live chain competes for a server.
  -h, --help       Show this help.
```

Exit codes: `0` nothing to reclaim, `1` orphaned processes found, `2` usage error, `3` the process table could not be read, `4` competing live chains found with `--strict`.

Competition is reported either way; `--strict` makes it change the exit code, so `--quiet --strict` is enough for a CI check. An orphan still exits `1` under `--strict`.

Output names each chain and its owner:

```text
$ bun bin/mcp-doctor.ts
chrome-devtools (chrome-devtools-mcp)
  in use    (claude pid 58337)  pids 58373,58567,58569
  in use    (opencode pid 89527)  pids 89958,89980,89981
  orphaned  (launcher gone)  pids 400,401
    reclaim: kill 401 400

2 live instances of chrome-devtools are running (claude, opencode). A new instance may fail
to start while they hold the same resources. chrome-devtools-mcp shares one Chrome profile by
default, so a second instance usually fails with "browser is already running".
```

- **in use**: a live process owns the chain. The owner is the first ancestor outside the
  chain: an OpenCode service, an editor, the `claude` CLI, or anything else that launched it.
- **orphaned**: the chain's launcher is gone. Reclaim it with the command on the `reclaim:` line:
  `kill <pids>` on macOS and Linux, `taskkill /PID <root> /T /F` on Windows. Ending one process
  does not end its descendants on either platform, which is why the command covers the whole chain.
- A chain includes helper processes that carry the server's name in their command line, such
  as the Chrome instance `chrome-devtools-mcp` started.

## Reading servers

Server commands come from the same configuration OpenCode reads, so the check uses your real launch commands rather than guessing from process names:

- Global: `~/.config/opencode/opencode.jsonc`, then `opencode.json`.
- Project, when the plugin runs: `opencode.jsonc` and `.opencode/opencode.jsonc` in the
  session's directory.

Both configuration shapes are understood: servers under `mcp.servers` and servers placed directly under `mcp`.

## Debugging the plugin

A plugin runs silently inside the host process, so `MCP_DOCTOR_DEBUG` writes one JSON line per decision to a file of your choosing:

```sh
MCP_DOCTOR_DEBUG=/tmp/mcp-doctor.log opencode run "use the chrome-devtools tools"
cat /tmp/mcp-doctor.log
```

```json
{"step":"setup","self":2093,"directory":"/path/to/project","targets":["chrome-devtools"]}
{"step":"scan","tool":"chrome-devtools_list_pages","others":[58373,89958]}
{"step":"notified","text":"mcp-doctor: 2 chrome-devtools instances are already running ..."}
```

## Notes

- Runs on macOS, Linux and Windows. Process information comes from `ps` on macOS and Linux, and
  from PowerShell's `Win32_Process` provider on Windows.
- When the process table cannot be read, the CLI exits `3` and the plugin says so once per
  session, rather than reporting a clean machine.
- The CLI is TypeScript run through the runtime's type stripping: it needs Bun, or Node 22.18+ where
  stripping is on by default. Node 22.6–22.17 work only with `--experimental-strip-types`.
- The notice is a session message. Clients that render session messages show it. `opencode run` prints only assistant output, so the note does not appear there.
- Configuration is read at load time. Add a server, then reload the plugin (`opencode service restart` or a config reload) for the check to cover it.

## Development

```sh
bun install
bun run typecheck
bun test
```

## License

MIT
