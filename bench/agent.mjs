// Times one long agent conversation in a real headless dsh on this provider
// and on dsh's Node runtime. A scripted model, served here as a Messages API
// stand-in, makes 40 run_code calls over a copy of five dsh packages, and
// each program calls dsh's own tools (glob, read, grep, bash). The script
// reads the time of every run_code call and of its nested tool calls from
// the Session log, samples the memory (PSS) of the dsh process tree every
// 25 ms, and takes the CPU time of the tree from bash's `times`. Linux only:
// the memory comes from /proc.
//
//   DSH_REPO=/path/to/deepseek-harness node bench/agent.mjs [rounds]
//
// DSH_REPO is a dsh checkout after `pnpm install` and `pnpm run build`. Build
// the sidecar and lib/ of this checkout first, as for the e2e test. Both
// runtimes run under workspace-write, the default file policy of a Session.
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = process.env.DSH_REPO
if (!repo) throw new Error('set DSH_REPO to a built deepseek-harness checkout')
if (process.platform !== 'linux') throw new Error('bench/agent.mjs reads memory from /proc and runs on Linux only')
const cli = join(repo, 'apps/cli/lib/bin.js')
const rounds = Number(process.argv[2] ?? 3)

const dirs = ['packages/core', 'packages/session', 'packages/sandbox', 'packages/subprocess', 'packages/ptc-runtime']
const patterns = ['TODO', 'throw new Error', 'export function', 'process\\.env', 'AbortSignal']

// The workspace: those packages as committed in the dsh checkout.
const work = await mkdtemp(join(tmpdir(), 'agent-bench-work-'))
execFileSync('bash', ['-c', `git -C "${repo}" archive HEAD ${dirs.join(' ')} | tar -x -C "${work}"`])

async function largest(dir) {
  let best = { path: '', size: -1 }
  for (const entry of await readdir(join(work, dir), { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    const path = join(entry.parentPath, entry.name)
    const { size } = await stat(path)
    if (size > best.size) best = { path: path.slice(work.length + 1), size }
  }
  return best.path
}

// Eight kinds of program per package: what an agent does while it learns a code base.
const steps = []
for (const [i, dir] of dirs.entries()) {
  const big = await largest(dir)
  const pattern = patterns[i].replaceAll('\\', '\\\\')
  steps.push(
    { description: `Inventory ${dir}`, code: `const found = await tools.glob({ pattern: "${dir}/**/*.ts" })
const byPackage: Record<string, number> = {}
for (const p of found.paths) { const d = p.split("/").slice(0, 3).join("/"); byPackage[d] = (byPackage[d] ?? 0) + 1 }
return { files: found.paths.length, packages: Object.entries(byPackage).sort((a, b) => b[1] - a[1]) }` },
    { description: `Read the sources of ${dir}`, code: `const found = await tools.glob({ pattern: "${dir}/*/src/*.ts" })
const picked = found.paths.slice(0, 6)
const files = await Promise.all(picked.map((p: string) => tools.read({ file_path: p })))
return files.map((f, i) => ({ path: picked[i], lines: f.totalLines, exports: f.lines.filter((l: { text: string }) => l.text.startsWith("export ")).length }))` },
    { description: `Find ${patterns[i]}`, code: `const hits = await tools.grep({ pattern: "${pattern}" })
const byFile: Record<string, number> = {}
for (const m of hits.matches) byFile[m.path] = (byFile[m.path] ?? 0) + 1
console.log("matches: " + hits.matches.length)
return Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 15)` },
    { description: `Count lines in ${dir}`, code: `const r = await tools.bash({ description: "Count TypeScript lines", command: "find ${dir} -name '*.ts' | xargs wc -l | tail -1" })
return r.stdout.text.trim()` },
    { description: `Largest file in ${dir}`, code: `const r = await tools.bash({ description: "Largest TypeScript file", command: "ls -S $(find ${dir} -name '*.ts') | head -1" })
const path = r.stdout.text.trim()
const f = await tools.read({ file_path: path })
return { path, totalLines: f.totalLines, head: f.lines.slice(0, 5).map((l: { text: string }) => l.text) }` },
    { description: `Word frequency of ${big}`, code: `const f = await tools.read({ file_path: "${big}" })
const counts: Record<string, number> = {}
for (const l of f.lines) for (const w of l.text.match(/[A-Za-z_]\\w+/g) ?? []) counts[w] = (counts[w] ?? 0) + 1
return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 20)` },
    { description: `Exported functions in ${dir}`, code: `const hits = await tools.grep({ pattern: "^export (async )?function" })
const files = [...new Set(hits.matches.map((m: { path: string }) => m.path))].filter((p) => p.startsWith("${dir}/")).slice(0, 3)
const contents = await Promise.all(files.map((p) => tools.read({ file_path: p })))
return contents.map((c, i) => ({ path: files[i], functions: c.lines.filter((l: { text: string }) => /^export (async )?function/.test(l.text)).map((l: { text: string }) => l.text) }))` },
    { description: `Tests in ${dir}`, code: `const found = await tools.glob({ pattern: "${dir}/**/*.spec.ts" })
for (const p of found.paths.slice(0, 30)) console.log(p)
return { tests: found.paths.length }` },
  )
}
const script = [...steps, { text: 'The five packages are surveyed.' }]

/** A Messages API stand-in: each request gets the next scripted step, a run_code call or the closing text. */
async function startModel() {
  let next = 0
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* the request body does not steer the script */ }
    if (request.method !== 'POST' || !request.url.endsWith('/v1/messages')) {
      response.writeHead(404).end()
      return
    }
    const index = next++
    const step = script[index] ?? script.at(-1)
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
    const send = event => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    send({ type: 'message_start', message: { id: `msg-${index}`, type: 'message', role: 'assistant', model: 'mock-model', content: [], usage: { input_tokens: 3, output_tokens: 0 } } })
    if (step.code === undefined) {
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text } })
    } else {
      send({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `call-${index + 1}`, name: 'run_code', input: {} } })
      send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ code: step.code, description: step.description }) } })
    }
    send({ type: 'content_block_stop', index: 0 })
    send({ type: 'message_delta', delta: { stop_reason: step.code === undefined ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } })
    send({ type: 'message_stop' })
    response.end()
  })
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { baseURL: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((resolve) => { server.close(resolve) }) }
}

function run(argv, options) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('exit', code => resolve({ code, stdout, stderr }))
    options.onSpawn?.(child)
  })
}

/** Every process below root, from /proc/<pid>/task/<tid>/children. */
function descendants(root) {
  const found = []
  const stack = [root]
  while (stack.length > 0) {
    const pid = stack.pop()
    let tasks = []
    try { tasks = readdirSync(`/proc/${pid}/task`) } catch { continue }
    for (const tid of tasks) {
      let children = ''
      try { children = readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8') } catch { continue }
      for (const child of children.split(' ').filter(Boolean)) {
        found.push(Number(child))
        stack.push(Number(child))
      }
    }
  }
  return found
}

const kib = (text, field) => Number(text.match(new RegExp(`^${field}:\\s+(\\d+) kB`, 'm'))?.[1] ?? 0)

/** Sample the PSS of the tree under root: the dsh process, the PTC runtime's processes, and the rest. */
function sampleMemory(root, markers) {
  const samples = []
  const runtimePids = new Set()
  let dsh
  const timer = setInterval(() => {
    const sample = { total: 0, dsh: 0, runtime: 0 }
    for (const pid of descendants(root)) {
      let rollup, cmdline
      try {
        rollup = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8')
        cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      } catch { continue }
      const pss = kib(rollup, 'Pss')
      sample.total += pss
      dsh ??= cmdline.includes('apps/cli/lib/bin.js') ? pid : undefined
      if (pid === dsh) sample.dsh += pss
      else if (markers.some(marker => cmdline.includes(marker))) {
        sample.runtime += pss
        runtimePids.add(pid)
      }
    }
    samples.push(sample)
  }, 25)
  return () => {
    clearInterval(timer)
    return { samples, runtimeProcesses: runtimePids.size }
  }
}

/** The length of the union of intervals, so concurrent tool calls count once. */
function covered(intervals) {
  let total = 0
  let end = -Infinity
  for (const [from, to] of intervals.toSorted((a, b) => a[0] - b[0])) {
    if (to <= end) continue
    total += to - Math.max(from, end)
    end = to
  }
  return total
}

async function sessionEvents(home) {
  let longest = ''
  for (const entry of await readdir(join(home, 'sessions'), { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.name !== 'session.v4.jsonl.zstd') continue
    const text = zstdDecompressSync(await readFile(join(entry.parentPath, entry.name))).toString('utf8')
    if (text.length > longest.length) longest = text
  }
  return longest.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function conversation(runtime) {
  const home = await mkdtemp(join(tmpdir(), `agent-bench-${runtime}-home-`))
  const env = { ...process.env, DSH_HOME: home }
  const profile = await run([process.execPath, cli, '--profile', 'bench', '--from-default-profile', 'headless', '--dump-config'], { cwd: repo, env })
  if (profile.code !== 0) throw new Error(`creating the profile failed: ${profile.stderr}`)
  let patch = '- id: tools\n  config:\n    mode: ptc\n- id: session-title-llm\n  disabled: true\n'
  if (runtime === 'moejs') {
    const add = await run([process.execPath, cli, 'plugin', '--profile', 'bench', 'add', pluginDir], { cwd: repo, env })
    if (add.code !== 0) throw new Error(`dsh plugin add failed: ${add.stderr}`)
    patch = '- id: ptc-runtime\n  disabled: true\n- id: ptc-moejs\n  disabled: false\n' + patch
  }
  await writeFile(join(home, 'profiles/bench/cordis.patch.yml'), patch)

  const model = await startModel()
  let stopSampling
  const started = performance.now()
  // bash reports the CPU time of dsh and every process below it once dsh exits.
  const result = await run(['bash', '-c', '"$@"; code=$?; times >&2; exit $code', 'bash', process.execPath, cli, '--profile', 'bench', 'Survey these packages.'], {
    cwd: work,
    env: { ...env, DEEPSEEK_BASE_URL: model.baseURL, DEEPSEEK_API_KEY: 'mock-key' },
    // On Linux a confined moejs sidecar runs from the descriptor of its binary.
    onSpawn: (child) => { stopSampling = sampleMemory(child.pid, runtime === 'moejs' ? ['moejs-ptc', '/proc/self/fd/3'] : ['ptc-runtime-node']) },
  })
  const wallMs = performance.now() - started
  const { samples, runtimeProcesses } = stopSampling()
  await model.stop()
  if (result.code !== 0) throw new Error(`${runtime}: dsh exited with ${result.code}: ${result.stderr.slice(-2000)}`)
  const times = result.stderr.trim().split('\n').at(-1).match(/(\d+)m([\d.]+)s (\d+)m([\d.]+)s/)
  const cpuMs = times === null ? Number.NaN : (Number(times[1]) * 60 + Number(times[2]) + Number(times[3]) * 60 + Number(times[4])) * 1000

  const calls = new Map()
  for (const event of await sessionEvents(home)) {
    const { type, data, time } = event
    if (type === 'tool/call' && data.name === 'run_code') calls.set(data.callId, { start: time, starts: new Map(), nested: [] })
    if (type === 'tool/ptc-dispatch-start') calls.get(data.rootCallId)?.starts.set(data.subCallId, time)
    if (type === 'tool/ptc-dispatch') {
      const call = calls.get(data.rootCallId)
      call?.nested.push([call.starts.get(data.subCallId), time])
    }
    const id = type === 'tool/result' ? data.callId ?? data.message?.toolCallId : undefined
    const call = id === undefined ? undefined : calls.get(id)
    if (call !== undefined) {
      call.end = time
      call.failed = data.message.isError === true || data.message.content.some(block => block.text?.startsWith('code run failed'))
    }
  }
  await rm(home, { recursive: true, force: true })
  const programs = [...calls.values()].map(call => ({ ms: call.end - call.start, toolMs: covered(call.nested), toolCalls: call.nested.length, failed: call.failed }))
  const sum = key => programs.reduce((total, program) => total + program[key], 0)
  const peak = key => Math.max(...samples.map(sample => sample[key])) / 1024
  const mean = key => samples.reduce((total, sample) => total + sample[key], 0) / samples.length / 1024
  return {
    runtime, programs, wallMs, cpuMs, runtimeProcesses,
    failed: programs.filter(program => program.failed).length,
    toolCalls: sum('toolCalls'), runCodeMs: sum('ms'), toolMs: sum('toolMs'),
    peakTree: peak('total'), meanTree: mean('total'), peakDsh: peak('dsh'), peakRuntime: peak('runtime'), meanRuntime: mean('runtime'),
  }
}

const results = []
for (let round = 0; round < rounds; round++) {
  for (const runtime of round % 2 === 0 ? ['moejs', 'node'] : ['node', 'moejs']) {
    const result = await conversation(runtime)
    results.push(result)
    console.error(`round ${round + 1} ${runtime}: ${result.programs.length} programs, ${result.failed} failed, run_code ${result.runCodeMs.toFixed(0)} ms, wall ${result.wallMs.toFixed(0)} ms`)
  }
}
await rm(work, { recursive: true, force: true })

const of = runtime => results.filter(result => result.runtime === runtime)
const average = (runtime, key) => of(runtime).reduce((total, result) => total + result[key], 0) / of(runtime).length
const median = values => {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const count = steps.length
console.log(`\n${count} run_code calls per conversation, ${rounds} conversations per runtime; averages per conversation:\n`)
console.log('| | Node runtime | moejs |\n|---|--:|--:|')
const row = (label, key, digits, unit) => console.log(`| ${label} | ${average('node', key).toFixed(digits)}${unit} | ${average('moejs', key).toFixed(digits)}${unit} |`)
row('failed programs', 'failed', 0, '')
row('nested tool calls', 'toolCalls', 0, '')
row('run_code time', 'runCodeMs', 0, ' ms')
row('of which nested tools', 'toolMs', 0, ' ms')
row('conversation wall time', 'wallMs', 0, ' ms')
row('CPU time of the process tree', 'cpuMs', 0, ' ms')
row('peak PSS of the process tree', 'peakTree', 0, ' MiB')
row('mean PSS of the process tree', 'meanTree', 0, ' MiB')
row('peak PSS of the dsh process', 'peakDsh', 0, ' MiB')
row('peak PSS of the PTC processes', 'peakRuntime', 1, ' MiB')
row('mean PSS of the PTC processes', 'meanRuntime', 1, ' MiB')
row('PTC processes, sandbox wrappers included', 'runtimeProcesses', 0, '')

// The saving of each program: its median time on the Node runtime minus its median time on moejs.
const savings = Array.from({ length: count }, (_, i) => median(of('node').map(r => r.programs[i].ms)) - median(of('moejs').map(r => r.programs[i].ms)))
const perProgram = (average('node', 'runCodeMs') - average('moejs', 'runCodeMs')) / count
const cpuPerProgram = (average('node', 'cpuMs') - average('moejs', 'cpuMs')) / count
console.log(`\nSaved per program: ${perProgram.toFixed(1)} ms of run_code time on average, median ${median(savings).toFixed(1)} ms, range ${Math.min(...savings).toFixed(1)} to ${Math.max(...savings).toFixed(1)} ms; ${cpuPerProgram.toFixed(1)} ms of CPU time.`)
console.log('\n| programs a day | run_code time saved | CPU time saved |\n|--:|--:|--:|')
for (const programs of [200, 1_000, 2_880, 11_520]) {
  console.log(`| ${programs.toLocaleString('en-US')} | ${(programs * perProgram / 60_000).toFixed(1)} min | ${(programs * cpuPerProgram / 60_000).toFixed(1)} min |`)
}
