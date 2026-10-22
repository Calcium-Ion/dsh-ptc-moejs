// End-to-end check inside a real dsh. In one headless run, the model (dsh's
// mock LLM server) calls run_code once, and the program calls three tools
// (glob, read, grep) and returns an object. The same task runs with this
// provider and with dsh's Node runtime, and the script compares what each
// Session log recorded.
//
//   DSH_REPO=/path/to/deepseek-harness node e2e/run.mjs
//
// DSH_REPO is a dsh checkout with dependencies installed and the host side
// built (pnpm install, pnpm run build). The moejs profile installs this
// checkout with `dsh plugin add`, so build the sidecar and lib/ first
// (pnpm run build:sidecar && pnpm run build).
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = process.env.DSH_REPO
if (!repo) throw new Error('set DSH_REPO to a built deepseek-harness checkout')
const cli = join(repo, 'apps/cli/lib/bin.js')

const program = `const found = await tools.glob({ pattern: "*.txt" })
const notes = await tools.read({ file_path: "notes.txt" })
const hits = await tools.grep({ pattern: "moejs" })
console.log("found " + found.paths.length + " text files")
return { files: found.paths.map(p => p.split("/").pop()).sort(), firstLine: notes.lines[0].text, matches: hits.matches.length }`
const finalText = 'Two text files; notes.txt mentions moejs.'

const selectMoejs = `# Run PTC programs in moejs instead of Node.
- id: ptc-runtime
  disabled: true
- id: ptc-moejs
  disabled: false
`
// PTC mode on. The LLM title generator is disabled so that every scripted response goes to the agent.
const common = `- id: tools
  config:
    mode: ptc
- id: session-title-llm
  disabled: true
`

function run(argv, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', code => resolve({ code, stdout, stderr }))
  })
}

async function startMock() {
  const toolArguments = JSON.stringify({ code: program, description: 'Summarize the text files' })
  const child = spawn(process.execPath, [
    '--import', 'tsx', 'packages/test-support/llm-mock-server/src/bin.ts',
    '--port', '0', '--api-key', 'mock-key', '--sequence', 'tool_call_success,success',
    '--tool-name', 'run_code', '--tool-arguments', toolArguments, '--success-text', finalText,
  ], { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'] })
  const records = []
  const lines = createInterface({ input: child.stdout })
  const baseURL = await new Promise((resolve, reject) => {
    lines.on('line', (line) => {
      const record = JSON.parse(line)
      records.push(record)
      if (record.type === 'ready') resolve(record.baseURL)
    })
    child.on('exit', code => reject(new Error(`mock server exited with ${code}`)))
  })
  return { baseURL, records, stop: () => child.kill() }
}

async function findSessionLog(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === 'session.v4.jsonl.zstd') return join(entry.parentPath, entry.name)
  }
  throw new Error(`no session log under ${dir}`)
}

async function scenario(runtime) {
  const home = await mkdtemp(join(tmpdir(), `dsh-e2e-${runtime}-home-`))
  const work = await mkdtemp(join(tmpdir(), `dsh-e2e-${runtime}-work-`))
  await writeFile(join(work, 'notes.txt'), 'moejs runs this program\nsecond line\n')
  await writeFile(join(work, 'other.txt'), 'other file, no match\n')
  const env = { ...process.env, DSH_HOME: home }
  const profile = await run([cli, '--profile', 'e2e', '--from-default-profile', 'headless', '--dump-config'], { cwd: repo, env })
  if (profile.code !== 0) throw new Error(`creating the profile failed: ${profile.stderr}`)
  if (runtime === 'moejs') {
    const add = await run([cli, 'plugin', '--profile', 'e2e', 'add', pluginDir], { cwd: repo, env })
    if (add.code !== 0) throw new Error(`dsh plugin add failed: ${add.stderr}`)
  }
  await writeFile(join(home, 'profiles/e2e/cordis.patch.yml'), (runtime === 'moejs' ? selectMoejs : '') + common)

  const mock = await startMock()
  const started = Date.now()
  const headless = await run([cli, '--profile', 'e2e', 'Summarize the text files in this directory'], {
    cwd: work,
    env: { ...env, DEEPSEEK_BASE_URL: mock.baseURL, DEEPSEEK_API_KEY: 'mock-key' },
  })
  const elapsedMs = Date.now() - started
  mock.stop()

  const text = zstdDecompressSync(await readFile(await findSessionLog(join(home, 'sessions')))).toString('utf8')
  const events = text.split('\n').filter(Boolean).map(line => JSON.parse(line))
  const starts = events.filter(e => e.type === 'tool/ptc-dispatch-start').map(e => e.data)
  const settles = events.filter(e => e.type === 'tool/ptc-dispatch').map(e => e.data)
  const result = events.find(e => e.type === 'tool/result')?.data.message.content.map(block => block.text).join('\n')
  const turnEnd = events.find(e => e.type === 'turn/end')?.data.reason.kind
  return { runtime, home, work, exit: headless.code, stdout: headless.stdout.trim(), stderr: headless.stderr.trim(), elapsedMs, requests: mock.records.filter(r => r.type === 'request').length, starts, settles, result, turnEnd }
}

const results = []
for (const runtime of ['moejs', 'node']) results.push(await scenario(runtime))

const checks = []
const check = (label, ok) => { checks.push({ label, ok }) }
for (const r of results) {
  check(`${r.runtime}: headless exits 0 with the model's final text`, r.exit === 0 && r.stdout === finalText)
  check(`${r.runtime}: the model made 2 requests`, r.requests === 2)
  check(`${r.runtime}: turn ended completed`, r.turnEnd === 'completed')
  check(`${r.runtime}: 3 dispatch starts glob, read, grep`, r.starts.map(s => s.name).join() === 'glob,read,grep')
  check(`${r.runtime}: 3 dispatch settles without error`, r.settles.length === 3 && r.settles.every(s => !s.isError))
  check(`${r.runtime}: sub-call ids follow the run_code call`, r.starts.every((s, i) => s.subCallId === `${s.parentCallId}:ptc:${i + 1}`))
}
const [moejs, node] = results
const strip = r => r.starts.map(s => ({ name: s.name, arguments: s.arguments }))
check('both runtimes dispatched the same calls with the same arguments', JSON.stringify(strip(moejs)) === JSON.stringify(strip(node)))
// Each scenario has its own workspace, which tool contents name.
const contents = r => JSON.stringify(r.settles.map(s => s.content)).replaceAll(r.work, '<work>')
check('both runtimes recorded the same tool contents', contents(moejs) === contents(node))
check('both runtimes gave the model the same run_code result', moejs.result === node.result)

for (const r of results) {
  console.log(`\n== ${r.runtime} (${r.elapsedMs} ms)`)
  for (const s of r.settles) console.log(`  ${s.subCallId}  ${s.name}(${JSON.stringify(s.arguments)})  isError=${s.isError}`)
  console.log(`  run_code result:\n${r.result.split('\n').map(line => `    ${line}`).join('\n')}`)
  if (r.exit !== 0) console.log(`  stderr: ${r.stderr}`)
}
console.log('')
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.label}`)
if (checks.every(c => c.ok)) {
  for (const r of results) await Promise.all([r.home, r.work].map(dir => rm(dir, { recursive: true, force: true })))
} else {
  for (const r of results) console.log(`${r.runtime}: DSH_HOME ${r.home}, workspace ${r.work}`)
  process.exitCode = 1
}
