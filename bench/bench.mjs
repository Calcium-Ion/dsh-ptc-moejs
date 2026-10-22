// Times the same small PTC program on this provider and on dsh's Node runtime
// (per-call mode) through the PtcRuntime service API: load, first run after
// load, and steady per-call time. Each measurement runs in a fresh worker
// process, and rounds alternate the order of the workers.
//
//   DSH_REPO=/path/to/deepseek-harness node bench/bench.mjs [rounds]
//
// The Node runtime runs with workspace-write, the default file policy of a
// dsh Session, which starts each program inside bubblewrap on Linux, and with
// danger-full-access, which starts the program process directly.
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')

const program = `const a = await tools.read({ path: "notes.txt" })
const b = await tools.grep({ pattern: "moejs" })
const c = await tools.bash({ command: "ls" })
return { files: [a.path, ...c.lines], matches: b.count, total: a.size + b.count + c.lines.length }`
const expected = JSON.stringify({ files: ['notes.txt', 'a', 'b'], matches: 2, total: 16 })
const functions = {
  read: () => Promise.resolve({ path: 'notes.txt', size: 12 }),
  grep: () => Promise.resolve({ count: 2 }),
  bash: () => Promise.resolve({ lines: ['a', 'b'] }),
}
const bindings = [{ global: 'tools', functions, errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' } }]
const calls = { moejs: 400, 'node-workspace-write': 40, 'node-danger-full-access': 40 }

async function mount(kind, workspace) {
  if (kind === 'moejs') {
    const require = createRequire(join(pluginDir, 'package.json'))
    const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
    const { default: Runtime } = await import(pathToFileURL(join(pluginDir, 'lib/index.js')).href)
    const ctx = new Context()
    return { ctx, load: () => ctx.plugin(Runtime, {}) }
  }
  const repo = process.env.DSH_REPO
  if (!repo) throw new Error('set DSH_REPO to a built deepseek-harness checkout')
  const nodeDir = join(repo, 'packages/ptc-runtime/ptc-runtime-node')
  const require = createRequire(join(nodeDir, 'package.json'))
  const load = async name => (await import(pathToFileURL(require.resolve(name)).href))
  const { Context } = await load('@deepseek-ai/cordis')
  const { default: Runtime } = await import(pathToFileURL(join(nodeDir, 'lib/index.js')).href)
  const ctx = new Context()
  await ctx.plugin((await load('@deepseek-ai/dsh-session')).default)
  await ctx.plugin((await load('@deepseek-ai/dsh-fs-local')).default)
  await ctx.plugin((await load('@deepseek-ai/dsh-subprocess-local')).default)
  await ctx.plugin((await load('@deepseek-ai/dsh-sandbox-local')).default, {})
  await ctx.plugin((await load('@deepseek-ai/dsh-session-projection')).default)
  const mode = kind === 'node-workspace-write' ? 'workspace-write' : 'danger-full-access'
  await ctx.plugin((await load('@deepseek-ai/dsh-sandbox-policy')).default, { mode, workspaceRoot: workspace })
  return { ctx, load: () => ctx.plugin(Runtime, {}) }
}

async function worker(kind) {
  const workspace = await mkdtemp(join(tmpdir(), 'ptc-bench-'))
  const { ctx, load } = await mount(kind, workspace)
  const loadStart = performance.now()
  await load()
  const loadMs = performance.now() - loadStart
  const runtime = ctx.ptcRuntime
  const once = async () => {
    const start = performance.now()
    const result = await runtime.run(runtime.resolve({ program, bindings, cwd: workspace }))
    const ms = performance.now() - start
    if (result.error !== undefined || JSON.stringify(result.value) !== expected) throw new Error(`${kind}: unexpected result ${JSON.stringify(result)}`)
    return ms
  }
  const firstMs = await once()
  const perCall = []
  for (let i = 0; i < calls[kind]; i++) perCall.push(await once())
  await ctx.fiber.dispose()
  await rm(workspace, { recursive: true, force: true })
  process.stdout.write(JSON.stringify({ kind, loadMs, firstMs, perCall }) + '\n')
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function runWorker(kind) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', kind], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('exit', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`${kind} worker exited with ${code}`)))
  })
}

async function main() {
  const rounds = Number(process.argv[2] ?? 5)
  const kinds = Object.keys(calls)
  const samples = Object.fromEntries(kinds.map(kind => [kind, []]))
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? kinds : [...kinds].reverse()
    for (const kind of order) {
      const sample = await runWorker(kind)
      samples[kind].push(sample)
      console.error(`round ${round + 1} ${kind}: per call ${median(sample.perCall).toFixed(3)} ms, first run ${sample.firstMs.toFixed(1)} ms, load ${sample.loadMs.toFixed(1)} ms`)
    }
  }
  const fmt = (values, digits) => `${median(values).toFixed(digits)} (${Math.min(...values).toFixed(digits)} to ${Math.max(...values).toFixed(digits)})`
  console.log(`\nMedians over ${rounds} rounds, with the range of the round medians, in ms:\n`)
  console.log('| runtime | per call | first run after load | load | load + first run |')
  console.log('|---|--:|--:|--:|--:|')
  for (const kind of kinds) {
    const s = samples[kind]
    console.log(`| ${kind} | ${fmt(s.map(x => median(x.perCall)), 3)} | ${fmt(s.map(x => x.firstMs), 1)} | ${fmt(s.map(x => x.loadMs), 1)} | ${fmt(s.map(x => x.loadMs + x.firstMs), 1)} |`)
  }
}

if (process.argv[2] === '--worker') await worker(process.argv[3])
else await main()
