<div align="center">

<img src="https://raw.githubusercontent.com/Calcium-Ion/moejs/main/docs/assets/moejs-logo.svg" width="160" alt="moejs">

# dsh-ptc-moejs

DeepSeek Harness 的 PTC 运行时，用 Go 写的 JavaScript 引擎 moejs 运行模型写的程序。

<p align="center">
  <strong>简体中文</strong> |
  <a href="./README.md">English</a>
</p>

</div>

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 PTC 模式下，模型给出一段调用工具的 TypeScript 程序。这个运行时让一个 sidecar 进程常驻，每段程序在里面拿到一个新的 [moejs](https://github.com/Calcium-Ion/moejs) 运行时。调用三次工具的程序在这里用时 0.18 ms。dsh 的 Node 运行时每段程序都要启动一个 Node 进程，同样的程序用时 95 ms。

程序对机器做的每件事都是一次工具调用，dsh 按该工具自己的策略、审批和沙箱执行这次调用。运行到了截止时间就会停下，死循环里也一样，分配的内存超过预算时也会停下。sidecar 是静态链接的 Go 程序，dsh 把它当作普通子进程启动，所以在无法运行 bubblewrap 的容器里也能用。

## 性能

两个运行时通过 dsh 的 `PtcRuntime` 服务接口运行同一段程序：三次工具调用，每次由绑定函数立即返回，最后返回一个对象。

| 运行时 | 每次调用 | 从加载到第一个结果 |
|---|--:|--:|
| dsh-ptc-moejs | 0.18 ms | 5.8 ms |
| dsh-ptc-runtime-node，workspace-write | 94.8 ms | 131.7 ms |
| dsh-ptc-runtime-node，danger-full-access | 91.2 ms | 135.0 ms |

一次调用是一次 `resolve` 加一次 `run`，从程序文本到结果。从加载到第一个结果是从挂载插件到第一次运行结束，moejs 的这段时间包含启动 sidecar。workspace-write 是 dsh 会话的默认文件策略，这时 Node 运行时在 bubblewrap 里启动每段程序。danger-full-access 下直接启动。

每一轮里，每个运行时都在新的 Node 进程中启动。5 轮交替顺序运行，绑定在 Intel Core i5-13500H 的 8 个核上，环境是 Linux 6.18、Node 24.22.1、Go 1.26.6、dsh 0.2.1-rc.2 和 moejs v0.1.0-alpha.9。表中是各轮中位数的中位数，moejs 的各轮中位数在 0.16 到 0.20 ms 之间，Node 在 90 到 96 ms 之间。

## 功能

### 对机器的每次操作都是工具调用

程序能调用 dsh 提供的工具，能向 `console` 输出。读文件、执行命令、抓取网页都要调用工具，dsh 用工具流水线执行这次调用，由该工具自己的策略、审批和沙箱处理，和 Node 运行时一样。dsh 的会话日志记录每一次调用。

### 每次运行一个新运行时

sidecar 在插件加载时启动，之后一直运行。每次运行拿到自己的 moejs 运行时，每段程序都从干净的全局环境开始，同一个 sidecar 里可以同时进行多次运行。

### 每次运行都有上限

一次运行默认可以分配 512 MiB，垃圾也算在内。截止时间到了、dsh 中止或者 profile 关闭时，运行立即停止。console 输出、返回值和发给 sidecar 的每条消息各有大小上限，见[配置](#配置)。

### 和 Node 运行时一样的 TypeScript

程序是只用可擦除语法的 TypeScript，规则和 dsh 的 Node 运行时相同：类型标注被删掉，`enum`、带值的 namespace 和参数属性都是语法错误。程序是一个 async 函数的函数体，顶层可以用 `await` 和 `return`。

### 一个静态程序

sidecar 是用 `CGO_ENABLED=0` 构建的自包含 Go 程序。dsh 把它当作普通子进程启动，运行时对宿主机的要求就是能启动这个进程。包管理器以可选依赖的形式安装对应平台的程序。

## 和 Node 运行时的区别

程序能用 JavaScript 标准库和工具。`require`、`import`、`process`、`Buffer`、`fs` 和 `setTimeout` 在程序里都是 undefined，程序要读文件时调用 `read` 工具。如果你的程序要用 Node API，这个 profile 继续用 dsh 的 Node 运行时。

程序的每次文件访问都发生在工具调用里，带 `sandbox_permissions` 的 `run_code` 调用会被 dsh 拒绝。文件沙箱拒绝某次工具调用时，程序在这次调用的参数里带上 `sandbox_permissions` 和 `justification` 重试，每次这样的调用都要你批准。用 Node 运行时的话，程序通过 Node API 自己做的文件操作还能用一次批准全部放行。

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
| `maxFrameBytes` | 64 MiB | dsh 和 sidecar 之间单条消息的上限：一段程序、一次工具调用的参数或一个工具结果。更大的工具结果在程序里表现为被拒绝的调用。 |

截止时间的默认值和 dsh 的 Node 运行时一致。dsh 会把超过 12,500 token 的工具结果转存到文件，所以日志和返回值的预算用来限制内存占用。

## 程序能看到什么

程序是一个 async 函数的函数体。函数的参数有 dsh 传入的绑定命名空间（PTC 模式下是 `tools`）、每个命名空间的错误类（`ToolCallError`，`toolName` 属性里是工具名），以及带 `log`、`info`、`warn`、`error`、`debug` 的 `console`。其余是 JavaScript 标准库，moejs 的标准库里有 `TextEncoder`、`TextDecoder`、`atob`、`btoa`、`structuredClone` 和 `queueMicrotask`。

模型写出的程序是这样的，运行时把返回值交给 dsh：

```ts
const head = await tools.bash({ description: "Read the last commit", command: "git log -1 --oneline" });
return { head: head.stdout?.text };
```

返回值以无损 JSON 的形式交给 dsh：普通对象、数组、字符串、有限数字、布尔值和 `null`。值里含有 `undefined`、函数、`BigInt`、循环引用、`NaN`、`Infinity`、`-0`、`Date`、`Map` 或类的实例时，运行以 `invalid-output` 失败，消息给出第一个这样的成员的路径，例如 `a BigInt at $.items[3].size`。程序没有返回值时，运行正常结束，结果里没有值。工具参数遵守同样的规则，参数不是无损 JSON 的调用在发给 dsh 之前就在程序内部被拒绝。

| 失败类型 | 什么时候出现 |
|---|---|
| `exception` | 程序抛出异常、有语法错误，或者用了会改变运行行为的 TypeScript，例如 `enum`。 |
| `timeout` | 超过截止时间，或者分配的内存超过 `memoryLimitMb`。 |
| `abort` | dsh 取消了这次运行，或者 profile 关闭了运行时。 |
| `invalid-output` | 返回值不是无损 JSON。 |
| `output-limit` | 返回值大于 `maxValueBytes`。 |
| `protocol` | 同时进行中的工具调用超过 `maxPendingCalls`，或者 sidecar 发来了格式错误的消息。 |
| `worker-exit` | sidecar 进程退出了。下一次运行会启动新的进程。 |

## 限制

- 每次调用都从新的运行时开始。在调用之间保留变量的持久模式（类似 Node 运行时的 REPL 模式）计划在以后的版本中加入。
- 内存预算统计的是一次运行分配的内存，垃圾也算在内。一次运行如果反复创建又丢弃大量数据，可能在存活数据达到预算之前就被停止。
- 两个方向的值最多嵌套 10,000 层，这是 moejs 的 JSON 读写能处理的深度。
- `console` 的输出仿照 Node 的 `util.inspect`，覆盖字符串、数字、普通对象、数组、`Map`、`Set`、错误和类的实例，单行超过 72 个字符时换行。
- moejs 的中断作用于正在运行的 JavaScript，编译一旦开始会一直进行到结束。解析很慢的程序到截止时间时，dsh 一侧照常结束这次运行，sidecar 等解析返回后丢弃它。
- 程序没有 await 的工具调用如果失败，这个失败只留在那个没人读取的 promise 里。
- CI 每次推送都在 Linux x64、Linux arm64、macOS arm64 和 Windows x64 上跑测试。macOS x64 还没测过，它的程序由同一份源码交叉编译。

## 开发

```sh
pnpm install
pnpm run build:sidecar   # 为本机构建 sidecar，放到 npm/<package>/bin
pnpm run build           # lib/
pnpm test                # 单元测试，以及针对 sidecar 的行为测试
go test ./...            # sidecar 的 Go 测试
DSH_REPO=/path/to/deepseek-harness pnpm run e2e     # 用 dsh 的 mock LLM 跑 headless dsh
DSH_REPO=/path/to/deepseek-harness pnpm run bench   # 上面的测量
pnpm run build:binaries  # 五个平台的程序
```

构建 sidecar 需要 Go 1.25 或更新版本，使用 `CGO_ENABLED=0`。`DSH_REPO` 是执行过 `pnpm install` 和 `pnpm run build` 的 dsh 源码目录。端到端测试用 `dsh plugin add` 把这个目录装进临时 profile，跑一个 headless 任务，让 mock 模型调用 `run_code`，再和 Node 运行时跑同一任务的会话日志做比较。

## 许可证

MIT。各平台包里的常驻进程二进制还包含 moejs（Apache License 2.0）和 Go 标准库（BSD 3-Clause License），它们的许可证原文在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 里，随每个平台包一起发布。
