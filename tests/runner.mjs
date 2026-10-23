// A stand-in sandbox runner for the tests: it runs the command after it with this process's stdio.
import { spawn } from 'node:child_process'
import { fstatSync } from 'node:fs'

const [command, ...args] = process.argv.slice(2)
// The host passes the sidecar's binary as fd 3 on Linux, and the command runs it from there.
// Elsewhere Node itself may hold fd 3, so nothing is passed on.
let binary = 'ignore'
if (process.platform === 'linux') {
  try {
    fstatSync(3)
    binary = 3
  } catch {
    // No descriptor came with this command.
  }
}
const child = spawn(command, args, { stdio: [0, 1, 2, binary] })
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === null ? 1 : 128) })
