// Times programs that use timers, modules and dsh's workflow guest, on this
// provider and on dsh's Node runtime (per-call mode), through the PtcRuntime
// service API. Each measurement runs in a fresh worker process, and rounds
// alternate the order of the workers. Both runtimes run under
// workspace-write, the default file policy of a dsh Session.
//
//   DSH_REPO=/path/to/deepseek-harness node bench/features.mjs [rounds]
//
// The workflow scenario runs the guest of dsh's workflow tool, read from the
// dsh checkout, with a host that answers every child agent at once.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')
const repo = process.env.DSH_REPO
if (!repo) throw new Error('set DSH_REPO to a built deepseek-harness checkout')

// A helper module of the kind a model writes once and imports from later programs.
const helper = `export interface Entry { path: string; size: number }
export interface Summary { files: number; bytes: number; largest: string; byDirectory: Array<[string, number]> }

function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash === -1 ? "." : path.slice(0, slash)
}

export function summarize(entries: Entry[]): Summary {
  const byDirectory = new Map<string, number>()
  let bytes = 0
  let largest: Entry | undefined
  for (const entry of entries) {
    bytes += entry.size
    if (largest === undefined || entry.size > largest.size) largest = entry
    const dir = directoryOf(entry.path)
    byDirectory.set(dir, (byDirectory.get(dir) ?? 0) + 1)
  }
  return {
    files: entries.length,
    bytes,
    largest: largest?.path ?? "",
    byDirectory: [...byDirectory].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  }
}

export function table(rows: Array<[string, number]>): string {
  const width = Math.max(...rows.map(([name]) => name.length))
  return rows.map(([name, count]) => name.padEnd(width) + "  " + String(count).padStart(4)).join("\\n")
}
`
const entries = Array.from({ length: 40 }, (_, i) => ({ path: `packages/p${i % 5}/src/f${i}.ts`, size: 100 + i * 7 }))

function guestProgram() {
  const source = readFileSync(join(repo, 'packages/workflow/workflow-ptc/src/guest-source.ts'), 'utf8')
  const guest = JSON.parse(source.match(/export const WORKFLOW_GUEST_SOURCE = (".*")/s)[1].trim().replace(/;\s*$/, ''))
  return `const { runWorkflowGuest } = await import(${JSON.stringify(`data:text/javascript,${encodeURIComponent(guest)}`)}); return await runWorkflowGuest(workflowHost);`
}

const workflowBody = `phase("Draft")
const first = await agent("Write a title")
const [a, b] = await parallel([() => agent("angle A"), () => agent("angle B")])
const piped = await pipeline(["x", "y"], (item) => agent("one " + item), (prev) => agent("two " + prev))
return { first, a, b, piped }`

function workflowHost() {
  let callId = 0
  const prompts = new Map()
  return {
    begin: () => Promise.resolve({ meta: { name: 'bench', description: 'A bench workflow' }, body: workflowBody, args: null, limits: { maxConcurrentAgents: 4, maxTotalAgents: 50, maxItemsPerCall: 10, syncTimeoutMs: 5000 } }),
    startChild: (request) => { const id = ++callId; prompts.set(id, request.prompt); return Promise.resolve({ callId: id, childId: `child-${id}` }) },
    childResult: ({ callId: id }) => Promise.resolve({ output: [{ type: 'text', text: `re: ${prompts.get(id)}` }], stopReason: 'completed' }),
    disposeChild: () => Promise.resolve(null),
    progress: () => Promise.resolve(null),
  }
}

const scenarios = {
  // The floor: a program that does nothing.
  'baseline': {
    program: () => 'return 1',
    check: value => value === 1,
  },
  // 1,000 turns of the event loop.
  'immediates': {
    program: () => 'for (let i = 0; i < 1000; i++) await new Promise(resolve => setImmediate(resolve))\nreturn 1000',
    check: value => value === 1000,
  },
  // Ten 1 ms sleeps through node:timers/promises.
  'sleeps': {
    program: () => 'const { setTimeout: sleep } = await import("node:timers/promises")\nfor (let i = 0; i < 10; i++) await sleep(1)\nreturn 10',
    check: value => value === 10,
  },
  // A TypeScript helper of the workspace, imported by its file URL, which both runtimes take.
  'helper module': {
    program: workspace => `const { summarize, table } = await import(${JSON.stringify(pathToFileURL(join(workspace, 'helper.ts')).href)})
const summary = summarize(${JSON.stringify(entries)})
return { ...summary, table: table(summary.byDirectory) }`,
    check: value => value?.files === 40 && typeof value.table === 'string',
  },
  // node:path and node:util.
  'node modules': {
    program: () => `const path = await import("node:path")
const util = await import("node:util")
const paths = []
for (let i = 0; i < 100; i++) paths.push(path.posix.join("/work", "pkg" + (i % 7), "..", "src", "f" + i + ".ts"))
return util.format("%d paths, first %s, deep %s", paths.length, paths[0], util.isDeepStrictEqual({ a: [1, 2] }, { a: [1, 2] }))`,
    check: value => value === '100 paths, first /work/src/f0.ts, deep true',
  },
  // dsh's workflow guest with seven child agents.
  'workflow': {
    program: () => guestProgram(),
    bindings: () => [{ global: 'workflowHost', functions: workflowHost() }],
    check: value => value?.stopReason === 'completed' && value.agentsStarted === 7,
  },
}
const runtimes = { moejs: 40, node: 8 }

async function mount(runtimeName, workspace) {
  const moejs = runtimeName === 'moejs'
  // Each runtime loads dsh's services from its own install: this checkout's for moejs, the dsh checkout's for Node.
  let base = pluginDir
  let runtime = join(pluginDir, 'lib/index.js')
  if (!moejs) {
    base = join(repo, 'packages/ptc-runtime/ptc-runtime-node')
    runtime = join(base, 'lib/index.js')
  }
  const require = createRequire(join(base, 'package.json'))
  const load = async name => (await import(pathToFileURL(require.resolve(name)).href))
  const { Context } = await load('@deepseek-ai/cordis')
  const { default: Runtime } = await import(pathToFileURL(runtime).href)
  const ctx = new Context()
  await ctx.plugin((await load('@deepseek-ai/dsh-session')).default)
  await ctx.plugin((await load('@deepseek-ai/dsh-fs-local')).default)
  if (!moejs) await ctx.plugin((await load('@deepseek-ai/dsh-subprocess-local')).default)
  await ctx.plugin((await load('@deepseek-ai/dsh-sandbox-local')).default, {})
  await ctx.plugin((await load('@deepseek-ai/dsh-session-projection')).default)
  await ctx.plugin((await load('@deepseek-ai/dsh-sandbox-policy')).default, { mode: 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(Runtime, {})
  return ctx
}

async function worker(runtimeName, scenarioName) {
  const scenario = scenarios[scenarioName]
  const workspace = await mkdtemp(join(tmpdir(), 'ptc-features-'))
  await writeFile(join(workspace, 'helper.ts'), helper)
  const ctx = await mount(runtimeName, workspace)
  const runtime = ctx.ptcRuntime
  const program = scenario.program(workspace)
  const once = async () => {
    const start = performance.now()
    const result = await runtime.run(runtime.resolve({ program, bindings: scenario.bindings?.() ?? [], cwd: workspace }))
    const ms = performance.now() - start
    if (result.error !== undefined || !scenario.check(result.value)) throw new Error(`${runtimeName} ${scenarioName}: unexpected result ${JSON.stringify(result).slice(0, 500)}`)
    return ms
  }
  const firstMs = await once()
  const perCall = []
  for (let i = 0; i < runtimes[runtimeName]; i++) perCall.push(await once())
  await ctx.fiber.dispose()
  await rm(workspace, { recursive: true, force: true })
  process.stdout.write(JSON.stringify({ firstMs, perCall }) + '\n')
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function runWorker(runtimeName, scenarioName) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', runtimeName, scenarioName], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('exit', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`${runtimeName} ${scenarioName} worker exited with ${code}`)))
  })
}

async function main() {
  const rounds = Number(process.argv[2] ?? 5)
  const samples = {}
  for (let round = 0; round < rounds; round++) {
    for (const scenarioName of Object.keys(scenarios)) {
      const order = round % 2 === 0 ? ['moejs', 'node'] : ['node', 'moejs']
      for (const runtimeName of order) {
        const sample = await runWorker(runtimeName, scenarioName)
        ;(samples[`${runtimeName} ${scenarioName}`] ??= []).push(sample)
        console.error(`round ${round + 1} ${runtimeName} ${scenarioName}: per call ${median(sample.perCall).toFixed(3)} ms, first run ${sample.firstMs.toFixed(1)} ms`)
      }
    }
  }
  const fmt = (values, digits) => `${median(values).toFixed(digits)} (${Math.min(...values).toFixed(digits)} to ${Math.max(...values).toFixed(digits)})`
  console.log(`\nMedians over ${rounds} rounds, with the range of the round medians, in ms:\n`)
  console.log('| program | moejs per call | Node per call | moejs first run | Node first run |')
  console.log('|---|--:|--:|--:|--:|')
  for (const scenarioName of Object.keys(scenarios)) {
    const m = samples[`moejs ${scenarioName}`]
    const n = samples[`node ${scenarioName}`]
    console.log(`| ${scenarioName} | ${fmt(m.map(s => median(s.perCall)), 3)} | ${fmt(n.map(s => median(s.perCall)), 1)} | ${fmt(m.map(s => s.firstMs), 1)} | ${fmt(n.map(s => s.firstMs), 1)} |`)
  }
}

if (process.argv[2] === '--worker') await worker(process.argv[3], process.argv[4])
else await main()
