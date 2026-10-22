<div align="center">

<img src="https://raw.githubusercontent.com/Calcium-Ion/moejs/main/docs/assets/moejs-logo.svg" width="160" alt="moejs">

# dsh-ptc-moejs

A PTC runtime for the DeepSeek Harness that runs the model's programs in moejs, a JavaScript engine written in Go.

<p align="center">
  <a href="./README.zh_CN.md">简体中文</a> |
  <strong>English</strong>
</p>

</div>

In the PTC mode of the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh), the model answers with a TypeScript program that calls tools. This runtime runs each program in a fresh [moejs](https://github.com/Calcium-Ion/moejs) runtime inside one sidecar process that stays up between programs. A program with three tool calls takes 0.18 ms here, and 95 ms on dsh's Node runtime, which starts a Node process for every program.

Everything a program does to the machine is a tool call, which dsh runs with that tool's own policy, approvals and sandbox. A run stops at its deadline, even in an endless loop, and when it goes past its memory budget. The sidecar is a static Go binary that dsh starts as a plain child process, so the runtime also works in containers where bubblewrap cannot run.

## Performance

Both runtimes ran the same program through dsh's `PtcRuntime` service API: three tool calls, each answered at once by its binding, and a returned object.

| Runtime | Per call | Load to first result |
|---|--:|--:|
| dsh-ptc-moejs | 0.18 ms | 5.8 ms |
| dsh-ptc-runtime-node, workspace-write | 94.8 ms | 131.7 ms |
| dsh-ptc-runtime-node, danger-full-access | 91.2 ms | 135.0 ms |

A call is one `resolve` and `run`, from the program text to the result. Load to first result runs from mounting the plugin to the end of its first run, and for moejs it includes starting the sidecar. Workspace-write is the default file policy of a dsh Session, under which the Node runtime starts each program inside bubblewrap. Danger-full-access starts it directly.

Every round started each runtime in a fresh Node process. The 5 rounds alternated the order of the runtimes on 8 cores of an Intel Core i5-13500H, with Linux 6.18, Node 24.22.1, Go 1.26.6, dsh 0.2.1-rc.2 and moejs v0.1.0-alpha.9. The table gives the median of the round medians, which stayed within 0.16 to 0.20 ms for moejs and within 90 to 96 ms for Node.

## Features

### Every effect is a tool call

A program can call the tools dsh gives it and write to `console`. To read a file, run a command or fetch a page, it calls a tool, and dsh runs that call through its tool pipeline with the tool's own policy, approvals and sandbox, as it does for the Node runtime. dsh's session log records each call.

### A fresh runtime for every run

The sidecar starts when the plugin loads and keeps running. Each run gets its own moejs runtime, so every program starts from clean globals, and one sidecar can have several runs in flight at once.

### Limits on every run

A run may allocate 512 MiB by default, garbage included. A deadline, an abort from dsh or a profile shutdown stops a run at once. Console output, the returned value and each message to the sidecar have their own size caps, listed under [Configuration](#configuration).

### TypeScript as on the Node runtime

Programs are TypeScript with erasable syntax, the rule dsh's Node runtime applies: the types are removed, and `enum`, namespaces with values and parameter properties are syntax errors. A program is the body of an async function, so `await` and `return` work at its top level.

### One static binary

The sidecar is a self-contained Go binary built with `CGO_ENABLED=0`. dsh starts it as a plain child process, and starting that process is all the runtime asks of the host. The package manager installs the binary for your platform as an optional dependency.

## Differences from the Node runtime

Programs get the JavaScript standard library and the tools. `require`, `import`, `process`, `Buffer`, `fs` and `setTimeout` are undefined in a program, and a program that needs a file asks the `read` tool for it. If your programs use Node APIs, keep dsh's Node runtime for that profile.

Every file access of a program happens inside a tool call, and dsh rejects a `run_code` call that carries `sandbox_permissions`. When the file sandbox denies a tool call, the program retries that call with `sandbox_permissions` and `justification` among its arguments, and you approve each such call. On the Node runtime, one approval can also cover the file operations a program does itself through Node APIs.

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
| `abort` | dsh cancels the run, or the profile shuts the runtime down. |
| `invalid-output` | The returned value is not lossless JSON. |
| `output-limit` | The returned value is larger than `maxValueBytes`. |
| `protocol` | More than `maxPendingCalls` tool calls are in flight, or the sidecar sent a malformed message. |
| `worker-exit` | The sidecar process died. The next run starts a new one. |

## Limitations

- Every call starts with a fresh runtime. A persistent mode that keeps variables between calls, like the Node runtime's REPL mode, is planned for a later version.
- The memory budget counts what a run allocates, garbage included. A long run that builds and drops a lot of data can stop before its live data reaches the budget.
- Values nest up to 10,000 levels deep in both directions, the depth moejs's JSON reader and writer handle.
- `console` output imitates Node's `util.inspect` for strings, numbers, plain objects, arrays, `Map`, `Set`, errors and class instances, and breaks a line at 72 characters.
- moejs interrupts running JavaScript, and a compile runs to its end once it starts. A program that takes long to parse still ends at its deadline for dsh, and the sidecar drops the run once the parse returns.
- If a tool call that the program never awaits fails, the failure stays in that unread promise.
- This version has been tested on Linux x64. The other four binaries are cross-compiled from the same source.

## Development

```sh
pnpm install
pnpm run build:sidecar   # the sidecar for this machine, into npm/<package>/bin
pnpm run build           # lib/
pnpm test                # unit tests and the behaviour suite against the sidecar
go test ./...            # the sidecar's Go tests
DSH_REPO=/path/to/deepseek-harness pnpm run e2e     # headless dsh with dsh's mock LLM
DSH_REPO=/path/to/deepseek-harness pnpm run bench   # the measurements above
pnpm run build:binaries  # all five platform binaries
```

Building the sidecar takes Go 1.25 or later, with `CGO_ENABLED=0`. `DSH_REPO` is a dsh checkout after `pnpm install` and `pnpm run build`. The e2e test installs this checkout into a temporary profile with `dsh plugin add`, runs one headless task in which the mock model calls `run_code`, and compares the Session log with the same task on the Node runtime.

## License

MIT. The sidecar binary in each platform package also contains moejs (Apache License 2.0) and the Go standard library (BSD 3-Clause License). Their license texts are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), which ships with each platform package.
