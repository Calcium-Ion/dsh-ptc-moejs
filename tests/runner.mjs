// A stand-in sandbox runner for the tests: it runs the command after it with this process's stdio.
import { spawn } from 'node:child_process'

const [command, ...args] = process.argv.slice(2)
const child = spawn(command, args, { stdio: 'inherit' })
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === null ? 1 : 128) })
