<div align="center">

<img src="https://raw.githubusercontent.com/Calcium-Ion/moejs/main/docs/assets/moejs-logo.svg" width="160" alt="moejs">

# dsh-ptc-moejs

A PTC runtime for the DeepSeek Harness that runs the model's programs in moejs, a JavaScript engine written in Go.

<p align="center">
  <a href="./README.zh_CN.md">简体中文</a> |
  <strong>English</strong>
</p>

</div>

In the PTC mode of the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh), the model answers with a TypeScript program that calls tools. This runtime runs each program in a fresh [moejs](https://github.com/Calcium-Ion/moejs) runtime inside a sidecar process that stays up between programs. A program with three tool calls takes 0.4 ms here, and 110 ms on dsh's Node runtime, which starts a Node process for every program.

Everything a program does to the machine is a tool call, which dsh runs with that tool's own policy, approvals and sandbox. The sidecar itself gets the confinement dsh's Node runtime gives a program: the file sandbox of the Session's policy and the same short environment. A run stops at its deadline, even in an endless loop, and when it goes past its memory budget.

## Performance

Both runtimes ran the same program through dsh's `PtcRuntime` service API, mounted on dsh's own services: three tool calls, each answered at once by its binding, and a returned object.

| Runtime | Per call | Load to first result |
|---|--:|--:|
| dsh-ptc-moejs, workspace-write | 0.42 ms | 16.4 ms |
| dsh-ptc-moejs, danger-full-access | 0.42 ms | 6.8 ms |
| dsh-ptc-runtime-node, workspace-write | 110.4 ms | 164.4 ms |
| dsh-ptc-runtime-node, danger-full-access | 103.0 ms | 149.2 ms |

A call is one `resolve` and `run`, from the program text to the result. Workspace-write is the default file policy of a dsh Session, under which both runtimes start their process inside bubblewrap: the Node runtime one process per program, moejs one sidecar for many programs. Danger-full-access starts the process directly. Load to first result runs from mounting the plugin to the end of its first run, and for moejs it includes starting the sidecar.

Every round started each runtime in a fresh Node process. The 5 rounds alternated the order of the runtimes on an Intel Core i5-13500H, with Linux 6.18, Node 24.22.1, Go 1.26.6, dsh 0.2.1-rc.2 and moejs v0.1.0-alpha.9. The table gives the median of the round medians, which stayed within 0.37 to 0.46 ms for moejs and within 100 to 114 ms for Node.

## Features

### Every effect is a tool call

A program can call the tools dsh gives it and write to `console`. To read a file, run a command or fetch a page, it calls a tool, and dsh runs that call through its tool pipeline with the tool's own policy, approvals and sandbox, as it does for the Node runtime. dsh's session log records each call.

### The Node runtime's sandbox

The sidecar runs under the same confinement as the Node runtime's program process:

- The policy is the one dsh resolves for the run: the Session's file mode and its workspace root, or the deployment's default for a run without a Session.
- dsh's sandbox service confines the sidecar with its runner for the host: bubblewrap or Landlock on Linux, Seatbelt on macOS, the restricted-token runner on Windows. Danger-full-access starts the sidecar without one.
- A restricted mode fails closed. When no runner can confine the sidecar, the run fails with `sandbox-unavailable`, as it does on the Node runtime, so a container where neither bubblewrap nor Landlock works needs danger-full-access.
- Of the dsh process's environment, the sidecar keeps only `PATH`, `PATHEXT`, `SYSTEMROOT`, `WINDIR`, `TEMP` and `TMP`, the variables the Node runtime keeps, so API keys stay out of it.
- A change of a Session's file mode stops that Session's runs under the old mode.

Each file policy in use has its own sidecar, which Sessions with the same mode and workspace root share. The sandbox applies to the sidecar process. The program has no file, network or process access of its own, so the policy decides what a tool call may do, not what the program does.

The plugin starts the sandboxed command itself. dsh's subprocess service, which starts the Node runtime's processes, also puts each one in a systemd scope behind a Node bootstrap on Linux, so that it can reap the child processes a program leaves behind. That adds about 80 ms to a start, and the sidecar starts no child processes. The sidecar always runs on the host that runs dsh: in a deployment whose execution world is another host, such as one over SSH, a restricted mode fails with `sandbox-unavailable`.

### A fresh runtime for every run

The sidecar of the default policy starts when the plugin loads, and each sidecar keeps running between programs. It exits after five minutes without runs, and the next run starts it again. Each run gets its own moejs runtime, so every program starts from clean globals, and one sidecar can have several runs in flight at once.

### Limits on every run

A run may allocate 512 MiB by default, garbage included. A deadline, an abort from dsh or a profile shutdown stops a run at once. Console output, the returned value and each message to the sidecar have their own size caps, listed under [Configuration](#configuration).

### TypeScript as on the Node runtime

Programs are TypeScript with erasable syntax, the rule dsh's Node runtime applies: the types are removed, and `enum`, namespaces with values and parameter properties are syntax errors. A program is the body of an async function, so `await` and `return` work at its top level.

### One static binary

The sidecar is a self-contained Go binary built with `CGO_ENABLED=0`. The package manager installs the binary for your platform as an optional dependency.

## Differences from the Node runtime

Programs get the JavaScript standard library and the tools. `require`, `import`, `process`, `Buffer`, `fs` and `setTimeout` are undefined in a program, and a program that needs a file asks the `read` tool for it. If your programs use Node APIs, keep dsh's Node runtime for that profile.

`run_code` takes `sandbox_permissions` and `justification` as it does on the Node runtime, and an approved request runs the program in a sidecar under the wider mode. The program does no file access of its own, so that approval lets it do nothing more. When the file sandbox denies a tool call, the program retries that call with `sandbox_permissions` and `justification` among its arguments, and you approve each such call. On the Node runtime, an approval for `run_code` also covers the file operations a program does itself through Node APIs.

## Quick start

```sh
dsh plugin --profile web add dsh-ptc-moejs
```

Use the name of the profile you run in place of `web`. The sidecar binary comes as an optional dependency for darwin-arm64, darwin-x64, linux-arm64, linux-x64 and win32-x64, so install with optional dependencies enabled.

Installing adds a disabled `ptc-moejs` row to the profile. To select it, add this patch to the profile's `cordis.patch.yml`, which is `~/.dsh/profiles/<name>/cordis.patch.yml` (or the same path under `$DSH_HOME`):

```yaml
# Replace the Node PTC runtime with moejs.
- id: ptc-runtime
  disabled: true
- id: ptc-moejs
  disabled: false
# Turn PTC mode on.
- id: tools
  config:
    mode: ptc
```

`dsh --profile web --dump-config` prints the composed rows. In the web and headless profiles, `DSH_TOOLS_MODE=ptc` also turns PTC mode on for one launch, in place of the `tools` entry. To go back to the Node runtime, delete the first two entries.

## Configuration

Options go on the `ptc-moejs` row of the same patch:

```yaml
- id: ptc-moejs
  disabled: false
  config:
    memoryLimitMb: 1024
    timeoutMs: 300000
```

| Option | Default | Meaning |
|---|--:|---|
| `timeoutMs` | 120000 | Deadline of a run in milliseconds when the model asks for none. Tool calls and approvals count toward it. |
| `maxTimeoutMs` | 600000 | The longest deadline a run may ask for. |
| `memoryLimitMb` | 512 | MiB a run may allocate over its whole life, garbage included. Past it the run stops with `timeout` and a message that names the budget. |
| `maxLogBytes` | 16 MiB | Bytes of console output a run keeps, counted as the JSON array dsh stores. Output past it is dropped, a marker line ends the logs, and the run goes on. |
| `maxValueBytes` | 16 MiB | Bytes of the returned value as JSON. A larger value fails the run with `output-limit`. Error messages are cut to this size. |
| `maxPendingCalls` | 128 | Tool calls a run may have in flight at once. One more fails the run with `protocol`. |
| `maxFrameBytes` | 64 MiB | The largest message between dsh and the sidecar: a program, the arguments of a tool call or one tool result. A larger tool result reaches the program as a rejected call. |

The deadline defaults follow dsh's Node runtime. dsh spills tool results longer than 12,500 tokens to a file, so the log and value budgets are limits on memory use.

## What a program sees

A program is the body of an async function. Its parameters are the binding namespaces dsh passes (`tools` in PTC mode), the error class of each namespace (`ToolCallError`, which carries the tool's name in `toolName`) and `console` with `log`, `info`, `warn`, `error` and `debug`. The rest is the JavaScript standard library, which in moejs includes `TextEncoder`, `TextDecoder`, `atob`, `btoa`, `structuredClone` and `queueMicrotask`.

The model writes a program like this one, and the runtime hands the returned value to dsh:

```ts
const head = await tools.bash({ description: "Read the last commit", command: "git log -1 --oneline" });
return { head: head.stdout?.text };
```

The returned value goes back to dsh as lossless JSON: plain objects, arrays, strings, finite numbers, booleans and `null`. A value that holds `undefined`, a function, a `BigInt`, a cycle, `NaN`, `Infinity`, `-0`, a `Date`, a `Map` or a class instance fails the run with `invalid-output`, and the message gives the path of the first such member, for example `a BigInt at $.items[3].size`. A program that returns nothing completes with no value. Tool arguments follow the same rule, and a call with arguments that are not lossless JSON rejects inside the program before dsh sees it.

| Failure kind | When |
|---|---|
| `exception` | The program throws, has a syntax error, or uses TypeScript that changes run-time behaviour, such as `enum`. |
| `timeout` | The deadline passes, or the program allocates more than `memoryLimitMb`. |
| `abort` | dsh cancels the run, the profile shuts the runtime down, or the Session's file mode changes. |
| `invalid-output` | The returned value is not lossless JSON. |
| `output-limit` | The returned value is larger than `maxValueBytes`. |
| `protocol` | More than `maxPendingCalls` tool calls are in flight, or the sidecar sent a malformed message. |
| `sandbox-unavailable` | The file mode needs a sandbox and no runner on this host can confine the sidecar, or the runner failed before the sidecar ran. |
| `worker-exit` | The sidecar process died or could not start. The next run starts a new one. |

A result also carries the facts of the sandbox the sidecar ran in, as on the Node runtime: the mode and, under a restricted mode, whether the runner enforces it fully or in part.

## Limitations

- Every call starts with a fresh runtime. A persistent mode that keeps variables between calls, like the Node runtime's REPL mode, is planned for a later version.
- The memory budget counts what a run allocates, garbage included. A long run that builds and drops a lot of data can stop before its live data reaches the budget.
- Values nest up to 10,000 levels deep in both directions, the depth moejs's JSON reader and writer handle.
- `console` output imitates Node's `util.inspect` for strings, numbers, plain objects, arrays, `Map`, `Set`, errors and class instances, and breaks a line at 72 characters.
- moejs interrupts running JavaScript, and a compile runs to its end once it starts. A program that takes long to parse still ends at its deadline for dsh, and the sidecar drops the run once the parse returns.
- If a tool call that the program never awaits fails, the failure stays in that unread promise.
- dsh's workflow tool loads its program with `import()`, which this runtime does not have, so workflows need the Node runtime.
- CI runs the tests on Linux x64, Linux arm64, macOS arm64 and Windows x64 for every push. macOS x64 is untested: its binary is cross-compiled from the same source.

## Development

```sh
pnpm install
pnpm run build:sidecar   # the sidecar for this machine, into npm/<package>/bin
pnpm run build           # lib/
pnpm test                # unit tests and the behaviour suite against the sidecar, on dsh's own services
go test ./...            # the sidecar's Go tests
DSH_REPO=/path/to/deepseek-harness pnpm run e2e     # headless dsh with dsh's mock LLM
DSH_REPO=/path/to/deepseek-harness pnpm run bench   # the measurements above
pnpm run build:binaries  # all five platform binaries
```

Building the sidecar takes Go 1.25 or later, with `CGO_ENABLED=0`. The tests mount dsh's fs, sandbox and policy packages, and one of them runs a program under this host's sandbox when a runner is usable. `DSH_REPO` is a dsh checkout after `pnpm install` and `pnpm run build`. The e2e test installs this checkout into a temporary profile with `dsh plugin add`, runs one headless task in which the mock model calls `run_code`, and compares the Session log, with the `run_code` parameters the model was offered, against the same task on the Node runtime.

## License

MIT. The sidecar binary in each platform package also contains moejs (Apache License 2.0) and the Go standard library (BSD 3-Clause License). Their license texts are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), which ships with each platform package.
