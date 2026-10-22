// Builds the moejs-ptc sidecar into the platform packages under npm/, with
// LICENSE and THIRD_PARTY_NOTICES.md beside it: all five targets, or with
// --host only the one this machine runs. Needs Go 1.25
// or later on PATH; the binaries are static (CGO_ENABLED=0).
import { execFileSync } from 'node:child_process'
import { copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const targets = [
  { name: 'darwin-arm64', goos: 'darwin', goarch: 'arm64' },
  { name: 'darwin-x64', goos: 'darwin', goarch: 'amd64' },
  { name: 'linux-arm64', goos: 'linux', goarch: 'arm64' },
  { name: 'linux-x64', goos: 'linux', goarch: 'amd64' },
  // npm's spam filter rejects dsh-ptc-moejs-win32-x64, so this package says "windows".
  { name: 'win32-x64', pkg: 'windows-x64', goos: 'windows', goarch: 'amd64' },
]

const host = `${process.platform}-${process.arch}`
const selected = process.argv.includes('--host') ? targets.filter(target => target.name === host) : targets
if (selected.length === 0) throw new Error(`no sidecar target for ${host}`)

for (const target of selected) {
  const binary = target.goos === 'windows' ? 'moejs-ptc.exe' : 'moejs-ptc'
  const dir = join(root, 'npm', `dsh-ptc-moejs-${target.pkg ?? target.name}`)
  const output = join(dir, 'bin', binary)
  execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', output, './cmd/moejs-ptc'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CGO_ENABLED: '0', GOOS: target.goos, GOARCH: target.goarch },
  })
  // The binary contains moejs and the Go runtime, so their licenses ship with it.
  copyFileSync(join(root, 'LICENSE'), join(dir, 'LICENSE'))
  copyFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(dir, 'THIRD_PARTY_NOTICES.md'))
  console.log(`built ${output}`)
}
