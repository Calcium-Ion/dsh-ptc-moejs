<div align="center">

<img src="https://raw.githubusercontent.com/Calcium-Ion/moejs/main/docs/assets/moejs-logo.svg" width="160" alt="moejs">

# dsh-ptc-moejs

DeepSeek Harness 的 PTC 运行时，用 Go 写的 JavaScript 引擎 moejs 运行模型写的程序。

<p align="center">
  <strong>简体中文</strong> |
  <a href="./README.md">English</a>
</p>

</div>

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 PTC 模式下，模型给出一段调用工具的 TypeScript 程序。这个运行时让 sidecar 进程常驻，每段程序在里面拿到一个新的 [moejs](https://github.com/Calcium-Ion/moejs) 运行时。调用三次工具的程序在这里用时 0.4 ms。dsh 的 Node 运行时每段程序都要启动一个 Node 进程，同样的程序用时 110 ms。

程序可以等待定时器，可以从工作目录导入辅助模块，可以用 `node:path`、`node:util` 和 `node:timers`。dsh 的 workflow 工具也能在这里运行它的脚本。

程序对机器做的每件事都是一次工具调用，dsh 按该工具自己的策略、审批和沙箱执行这次调用。sidecar 本身只读取程序导入的代码文件，它受到的限制和 dsh 的 Node 运行时给程序的一样：会话文件策略的沙箱，以及同样精简的环境变量。运行到了截止时间就会停下，死循环里也一样，分配的内存超过预算时也会停下。

## 性能

两个运行时挂载在 dsh 自己的服务上，通过 dsh 的 `PtcRuntime` 服务接口运行同一段程序：三次工具调用，每次由绑定函数立即返回，最后返回一个对象。

| 运行时 | 每次调用 | 从加载到第一个结果 |
|---|--:|--:|
| dsh-ptc-moejs，workspace-write | 0.42 ms | 16.4 ms |
| dsh-ptc-moejs，danger-full-access | 0.42 ms | 6.8 ms |
| dsh-ptc-runtime-node，workspace-write | 110.4 ms | 164.4 ms |
| dsh-ptc-runtime-node，danger-full-access | 103.0 ms | 149.2 ms |

一次调用是一次 `resolve` 加一次 `run`，从程序文本到结果。workspace-write 是 dsh 会话的默认文件策略，这时两个运行时都在 bubblewrap 里启动进程：Node 运行时每段程序一个进程，moejs 是许多段程序共用一个 sidecar。danger-full-access 下直接启动。从加载到第一个结果是从挂载插件到第一次运行结束，moejs 的这段时间包含启动 sidecar。

每一轮里，每个运行时都在新的 Node 进程中启动。5 轮交替顺序运行，环境是 Intel Core i5-13500H、Linux 6.18、Node 24.22.1、Go 1.26.6、dsh 0.2.1-rc.2 和 moejs v0.1.0-alpha.9。表中是各轮中位数的中位数，moejs 的各轮中位数在 0.37 到 0.46 ms 之间，Node 在 100 到 114 ms 之间。

### 一次长的 agent 对话

`bench/agent.mjs` 在 headless dsh 里分别用两个运行时跑同一段对话。一个按脚本应答的模型发起 40 次 `run_code`，对象是五个 dsh 包的副本，这些程序一共调用 90 次 dsh 的工具：glob、read、grep 和 bash。两个运行时都在同一台机器上、在 workspace-write 下运行。表中是每个运行时 3 段对话的平均值。

| | dsh-ptc-runtime-node | dsh-ptc-moejs |
|---|--:|--:|
| `run_code` 耗时 | 8.6 s | 3.6 s |
| 其中嵌套的工具调用 | 3.5 s | 3.3 s |
| 整段对话的墙钟时间 | 10.1 s | 5.0 s |
| dsh 及其子进程的 CPU 时间 | 8.4 s | 5.2 s |
| dsh 及其子进程的内存峰值（PSS） | 440 MiB | 437 MiB |
| PTC 运行时进程的内存峰值（PSS） | 34.0 MiB | 18.5 MiB |
| PTC 运行时的进程数，含 bubblewrap 的进程 | 120 | 3 |

每段程序在 moejs 上少用 125 ms，按程序不同在 89 到 159 ms 之间，CPU 时间少 82 ms，没有一段程序更慢。工具调用在两个运行时上用时差不多，差别在于 Node 运行时为每段程序在 bubblewrap 里启动一个 Node 进程。两个运行时的内存峰值差不多，其中约 385 MiB 是 dsh 进程本身。Node 运行时给每段程序的进程最高到 34 MiB，程序结束就退出；moejs 的 sidecar 和它的 bubblewrap 进程在整段对话里一直运行，最高 18.5 MiB。

### 一天的 agent 工作

节省的时间随程序的数量增长。按脚本应答的模型会立即回复，真实模型每一步的时间在两个运行时上一样多，所以省下的是 agent 等程序结果的时间。下表把实测的每段程序 125 ms 和 82 ms CPU 时间乘以一天的程序数，举例时假设每 10 秒运行一段程序。

| 每天的程序数 | 例如 | 少等的时间 | 节省的 CPU 时间 |
|--:|---|--:|--:|
| 200 | 半小时的 agent 工作 | 25 s | 16 s |
| 1,000 | 约 3 小时 | 2.1 min | 1.4 min |
| 2,880 | 一个 agent 连续工作 8 小时 | 6.0 min | 3.9 min |
| 11,520 | 四个这样的 agent 并行 | 24 min | 16 min |

连续工作 8 小时的 agent，在 Node 运行时上有 10.3 分钟花在 `run_code` 上，在 moejs 上是 4.3 分钟。要估算自己的情况，把你的 agent 一天运行的程序数乘以 125 ms。

## 功能

### 对机器的每次操作都是工具调用

程序能调用 dsh 提供的工具，能向 `console` 输出。读文件、执行命令、抓取网页都要调用工具，dsh 用工具流水线执行这次调用，由该工具自己的策略、审批和沙箱处理，和 Node 运行时一样。dsh 的会话日志记录每一次调用。sidecar 自己读取的只有程序导入的代码文件，读取时受这次运行的策略的沙箱限制。

### 和 Node 运行时一样的沙箱

sidecar 受到的限制和 Node 运行时的程序进程相同：

- 策略就是 dsh 为这次运行解析出来的策略：会话的文件模式和它的工作区根目录；没有会话的运行用部署的默认策略。
- dsh 的沙箱服务用本机的 runner 限制 sidecar：Linux 上是 bubblewrap 或 Landlock，macOS 上是 Seatbelt，Windows 上是受限令牌 runner。danger-full-access 下 sidecar 直接启动，不经过 runner。
- 受限模式在无法限制时直接失败。没有 runner 能限制 sidecar 时，运行以 `sandbox-unavailable` 失败，和 Node 运行时一样，所以在 bubblewrap 和 Landlock 都用不了的容器里要用 danger-full-access。
- dsh 进程的环境变量里，sidecar 只保留 `PATH`、`PATHEXT`、`SYSTEMROOT`、`WINDIR`、`TEMP` 和 `TMP`，也就是 Node 运行时保留的那些，API key 不会进到 sidecar 里。
- 会话的文件模式改变时，这个会话里按旧模式进行的运行会被停止。

在 Linux 上，插件自己打开 sidecar 的二进制文件，加了沙箱的 sidecar 从这个打开的文件运行，所以即使沙箱藏起了二进制所在的目录（比如 workspace-write 下 bubblewrap 会把 /tmp 换成空目录），sidecar 也能启动。这样的 sidecar 在 `ps` 里显示为 `/proc/self/fd/3`。

每个在用的文件策略有自己的 sidecar，模式和工作区根目录相同的会话共用一个。沙箱作用在 sidecar 进程上。除了读取它导入的文件，程序自己不能访问文件、网络和进程，所以策略决定的是工具调用能做什么，而不是程序本身做什么。

加了沙箱的命令由插件自己启动。dsh 的子进程服务启动 Node 运行时的进程时，在 Linux 上还会先建一个 systemd scope、经过一个 Node 引导进程，用来回收程序留下的子进程。这会让每次启动多花约 80 ms，而 sidecar 不会启动子进程。sidecar 总是运行在运行 dsh 的这台机器上：执行环境在另一台机器上的部署（例如通过 SSH）里，受限模式会以 `sandbox-unavailable` 失败。

### 每次运行一个新运行时

默认策略的 sidecar 在插件加载时启动，每个 sidecar 在两段程序之间一直运行。连续五分钟没有运行时它会退出，下一次运行再启动。每次运行拿到自己的 moejs 运行时，每段程序都从干净的全局环境开始，同一个 sidecar 里可以同时进行多次运行。

### 每次运行都有上限

一次运行默认可以分配 512 MiB，垃圾也算在内。截止时间到了、dsh 中止或者 profile 关闭时，运行立即停止。console 输出、返回值和发给 sidecar 的每条消息各有大小上限，见[配置](#配置)。

### 和 Node 运行时一样的 TypeScript

程序是只用可擦除语法的 TypeScript，规则和 dsh 的 Node 运行时相同：类型标注被删掉，`enum`、带值的 namespace 和参数属性都是语法错误。程序是一个 async 函数的函数体，顶层可以用 `await` 和 `return`。

### 定时器

`setTimeout`、`setInterval`、`setImmediate` 和对应的 clear 函数和 Node 里的一样，`Timeout` 对象有 `ref`、`unref`、`hasRef`、`refresh` 和 `close`，`node:timers/promises` 提供它们的 promise 形式。程序可以在两次工具调用之间等待、轮询，或者按退避间隔重试：

```ts
const { setTimeout: sleep } = await import("node:timers/promises");
for (let attempt = 1; attempt <= 10; attempt++) {
  const status = await tools.bash({ description: "Check the build", command: "cat build/status" });
  if (status.stdout?.text.trim() === "done") return "built";
  await sleep(2000);
}
return "still building";
```

定时器回调在程序的运行时里执行，所以算进它的内存预算和截止时间。程序返回时还没触发的定时器不会再执行，就像 Node 运行时的进程随程序一起结束一样。

### 模块

程序用 `await import(...)` 加载模块：

- 工作目录下的 `.ts`、`.mts`、`.js` 和 `.mjs` 文件，写出扩展名，用相对工作目录的路径、绝对路径或 `file:` URL 指定。被导入的模块可以用 `import` 声明导入其他文件，可以用 `console` 和定时器。工具绑定由程序作为参数传给它。
- `node:path`、`node:util`、`node:timers`、`node:timers/promises` 和 `node:vm`，不写 `node:` 前缀也可以。
- JavaScript 的 `data:` URL。

```ts
const { summarize } = await import("./scripts/summarize.ts");
return await summarize(tools, "docs/");
```

被导入的文件由 sidecar 自己读取，读取时受这次运行的沙箱限制。同一份内容只编译一次：之后的运行导入同一个没改过的文件时不再编译。工作目录之外的路径、指向工作目录之外的符号链接、包名、JSON 文件和其他 Node 模块都会失败，错误消息说明原因。只有 dsh 的执行环境就是运行 dsh 的这台机器时，才能加载文件。执行环境在另一台机器上时（例如通过 SSH），内置模块仍然可以加载。

### Workflow

dsh 的 workflow 工具可以在这个运行时上运行。它的 guest 从 `data:` URL 加载，通过 `node:vm` 运行每个 workflow 脚本。这里的 `node:vm` 在程序自己的运行时里运行脚本，context 对象的属性就是脚本的全局变量。脚本里的 `agent()`、`parallel()`、`pipeline()`、`phase()` 和 `log()` 和在 Node 运行时上一样。

### 一个静态程序

sidecar 是用 `CGO_ENABLED=0` 构建的自包含 Go 程序。包管理器以可选依赖的形式安装对应平台的程序。

## 和 Node 运行时的区别

程序能用 JavaScript 标准库、工具、Node 的定时器和五个 Node 模块：`node:path`、`node:util`、`node:timers`、`node:timers/promises` 和 `node:vm`。`require`、`process`、`Buffer`、`fs`、包和其他 Node 模块都用不了，程序要读文件内容时调用 `read` 工具。如果你的程序要用其他 Node API，这个 profile 继续用 dsh 的 Node 运行时。

在 Node 运行时上，程序里的 `import("./helper.ts")` 相对 dsh 自己的引导文件解析，所以那里的程序要用绝对路径导入文件。这里两种写法都可以，相对路径相对工作目录解析。

`node:vm` 在程序自己的运行时里运行脚本。脚本的 `timeout` 选项不生效，不会结束的脚本由这次运行的截止时间停止。脚本里的 `var` 和 `function` 声明留在脚本自己的作用域里，给 context 上没有的名字赋值会在程序的运行时里创建全局变量，而 Node 会把这两者都放到 context 上。所以死循环的 workflow 会以它的 `run_code` 调用的 `timeout` 结束，而 Node 运行时报告的是脚本自己的超时。这类脚本的栈帧显示的是 `node:vm`，而不是脚本的文件名。

`run_code` 和在 Node 运行时上一样接受 `sandbox_permissions` 和 `justification`，批准后程序在放宽模式的 sidecar 里运行。除了读取它导入的文件，程序自己不做文件访问，所以这次批准不会让它多做任何事。文件沙箱拒绝某次工具调用时，程序在这次调用的参数里带上 `sandbox_permissions` 和 `justification` 重试，每次这样的调用都要你批准。用 Node 运行时的话，对 `run_code` 的批准还会放行程序通过 Node API 自己做的文件操作。

## 快速上手

```sh
dsh plugin --profile web add dsh-ptc-moejs
```

把 `web` 换成你使用的 profile 名。sidecar 程序以可选依赖的形式提供，覆盖 darwin-arm64、darwin-x64、linux-arm64、linux-x64 和 win32-x64，安装时需要启用可选依赖。

安装后 profile 里多出一行处于禁用状态的 `ptc-moejs`。要启用它，把下面的补丁加进 profile 的 `cordis.patch.yml`，路径是 `~/.dsh/profiles/<name>/cordis.patch.yml`（设置了 `$DSH_HOME` 时在它下面的同一路径）：

```yaml
# 用 moejs 替换 Node PTC 运行时。
- id: ptc-runtime
  disabled: true
- id: ptc-moejs
  disabled: false
# 打开 PTC 模式。
- id: tools
  config:
    mode: ptc
```

`dsh --profile web --dump-config` 会打印组合后的配置行。在 web 和 headless profile 里，也可以用 `DSH_TOOLS_MODE=ptc` 在单次启动时打开 PTC 模式，代替 `tools` 那一项。要换回 Node 运行时，删掉前两项。

## 配置

选项写在同一个补丁的 `ptc-moejs` 行上：

```yaml
- id: ptc-moejs
  disabled: false
  config:
    memoryLimitMb: 1024
    timeoutMs: 300000
```

| 选项 | 默认值 | 含义 |
|---|--:|---|
| `timeoutMs` | 120000 | 模型没有指定时，一次运行的截止时间（毫秒）。工具调用和审批的时间都算在内。 |
| `maxTimeoutMs` | 600000 | 一次运行可以请求的最长截止时间。 |
| `memoryLimitMb` | 512 | 一次运行在整个生命周期里可以分配的 MiB 数，垃圾也算在内。超过后运行以 `timeout` 停止，消息里写明是哪个预算。 |
| `maxLogBytes` | 16 MiB | 一次运行保留的 console 输出字节数，按 dsh 存储的 JSON 数组计算。超出部分被丢弃，日志以一行标记结尾，运行继续。 |
| `maxValueBytes` | 16 MiB | 返回值序列化成 JSON 后的字节数。更大的值让运行以 `output-limit` 失败。错误消息也截断到这个长度。 |
| `maxPendingCalls` | 128 | 一次运行同时进行中的工具调用数。再多一个，运行以 `protocol` 失败。 |
| `maxPendingTimers` | 65536 | 一次运行同时挂着的定时器和 immediate 数。再多一个，程序里抛出 `RangeError`。 |
| `maxFrameBytes` | 64 MiB | dsh 和 sidecar 之间单条消息的上限：一段程序、一次工具调用的参数或一个工具结果。更大的工具结果在程序里表现为被拒绝的调用。 |

截止时间的默认值和 dsh 的 Node 运行时一致。dsh 会把超过 12,500 token 的工具结果转存到文件，所以日志和返回值的预算用来限制内存占用。

## 程序能看到什么

程序是一个 async 函数的函数体。函数的参数有 dsh 传入的绑定命名空间（PTC 模式下是 `tools`）、每个命名空间的错误类（`ToolCallError`，`toolName` 属性里是工具名），以及带 `log`、`info`、`warn`、`error`、`debug` 的 `console`。`console` 也是全局变量，`setTimeout`、`setInterval`、`setImmediate` 和对应的 clear 函数也是，所以程序导入的模块也能用它们；绑定命名空间不是全局变量。其余是 JavaScript 标准库，moejs 的标准库里有 `TextEncoder`、`TextDecoder`、`atob`、`btoa`、`structuredClone` 和 `queueMicrotask`。

模型写出的程序是这样的，运行时把返回值交给 dsh：

```ts
const head = await tools.bash({ description: "Read the last commit", command: "git log -1 --oneline" });
return { head: head.stdout?.text };
```

返回值以无损 JSON 的形式交给 dsh：普通对象、数组、字符串、有限数字、布尔值和 `null`。值里含有 `undefined`、函数、`BigInt`、循环引用、`NaN`、`Infinity`、`-0`、`Date`、`Map` 或类的实例时，运行以 `invalid-output` 失败，消息给出第一个这样的成员的路径，例如 `a BigInt at $.items[3].size`。程序没有返回值时，运行正常结束，结果里没有值。工具参数遵守同样的规则，参数不是无损 JSON 的调用在发给 dsh 之前就在程序内部被拒绝。

| 失败类型 | 什么时候出现 |
|---|---|
| `exception` | 程序或定时器回调抛出异常、有 promise 被拒绝却没有处理、程序有语法错误，或者用了会改变运行行为的 TypeScript，例如 `enum`。 |
| `timeout` | 超过截止时间，或者分配的内存超过 `memoryLimitMb`。 |
| `abort` | dsh 取消了这次运行、profile 关闭了运行时，或者会话的文件模式改变了。 |
| `invalid-output` | 返回值不是无损 JSON。 |
| `output-limit` | 返回值大于 `maxValueBytes`。 |
| `protocol` | 同时进行中的工具调用超过 `maxPendingCalls`，或者 sidecar 发来了格式错误的消息。 |
| `sandbox-unavailable` | 文件模式需要沙箱，但本机没有 runner 能限制 sidecar，或者 runner 在 sidecar 运行之前就失败了。 |
| `worker-exit` | sidecar 进程退出了或者没能启动。下一次运行会启动新的进程。 |

和 Node 运行时一样，结果里还带有 sidecar 所在沙箱的情况：模式，以及受限模式下 runner 是完整还是部分执行了这个模式。

## 限制

- 每次调用都从新的运行时开始。在调用之间保留变量的持久模式（类似 Node 运行时的 REPL 模式）计划在以后的版本中加入。
- 内存预算统计的是一次运行分配的内存，垃圾也算在内。一次运行如果反复创建又丢弃大量数据，可能在存活数据达到预算之前就被停止。
- 两个方向的值最多嵌套 10,000 层，这是 moejs 的 JSON 读写能处理的深度。
- `console` 用移植自 Node 22 的 `util.inspect` 渲染值，选项和 dsh 的 Node 运行时一样：深度 4、100 项、字符串 10,000 个字符。Node 24 写对象的 symbol 键时不带方括号。Node 的 `util.inspect` 能用 `showProxy` 显示 proxy 的目标，能显示迭代器和 `WeakMap` 的条目，moejs 不提供这些。
- 一次运行最多导入 256 个文件，每个最大 1 MiB，合计最大 8 MiB。moejs 没有 import attributes，所以没有 JSON 模块。程序是函数体，所以程序里用 `import()` 导入，`import` 声明在被导入的模块里可以用。
- moejs 的中断作用于正在运行的 JavaScript，编译一旦开始会一直进行到结束。解析很慢的程序到截止时间时，dsh 一侧照常结束这次运行，sidecar 等解析返回后丢弃它。
- 一个 promise 被拒绝后，到它所在回调的 promise 任务跑完时仍没有处理函数，这次运行就会失败，就像未处理的拒绝会结束 Node 运行时的进程一样。程序没有 await 的工具调用在工具失败时会这样让运行失败，`async` 定时器回调里的异常也一样。消息以 `Uncaught (in promise)` 开头。
- 程序第一行上的栈帧，列号从程序所在函数的开头算起。运行失败的消息和 `console` 给出的是程序自己的列号；程序自己读取的错误 `stack` 仍从函数开头算。
- CI 每次推送都在 Linux x64、Linux arm64、macOS arm64 和 Windows x64 上跑测试。macOS x64 还没测过，它的程序由同一份源码交叉编译。

## 开发

```sh
pnpm install
pnpm run build:sidecar   # 为本机构建 sidecar，放到 npm/<package>/bin
pnpm run build           # lib/
pnpm test                # 单元测试，以及在 dsh 自己的服务上针对 sidecar 的行为测试
go test ./...            # sidecar 的 Go 测试
DSH_REPO=/path/to/deepseek-harness pnpm run e2e     # 用 dsh 的 mock LLM 跑 headless dsh
DSH_REPO=/path/to/deepseek-harness pnpm run bench   # 上面的测量
DSH_REPO=/path/to/deepseek-harness pnpm run bench:agent   # 长对话测评，需要 Linux
pnpm run build:binaries  # 五个平台的程序
```

构建 sidecar 需要 Go 1.25 或更新版本，使用 `CGO_ENABLED=0`。测试挂载 dsh 的 fs、沙箱和策略包，本机有可用的 runner 时，其中一个测试会在本机沙箱里运行程序。`DSH_REPO` 是执行过 `pnpm install` 和 `pnpm run build` 的 dsh 源码目录。端到端测试用 `dsh plugin add` 把这个目录装进临时 profile，跑一个 headless 任务，让 mock 模型调用 `run_code`，再和 Node 运行时跑同一任务的会话日志做比较，包括提供给模型的 `run_code` 参数。

## 许可证

MIT。各平台包里的常驻进程二进制还包含 moejs（Apache License 2.0）、Go 标准库（BSD 3-Clause License）以及移植自 Node.js 的 `path` 模块和 `util.inspect`（MIT License），它们的许可证原文在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 里，随每个平台包一起发布。
