// Manual smoke test: launch the built helper through LaunchServices, send ping + permissions, print replies.
// Usage: pnpm build:computer-use && node scripts/computer-use-smoke.mjs
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const app = join(root, 'build/computer-use/pi-gna Computer Use.app')
if (!existsSync(app)) throw new Error('run `pnpm build:computer-use` first')

const id = randomBytes(4).toString('hex')
const token = randomBytes(24).toString('hex')
const sock = join(tmpdir(), `cu-${id}.sock`)
execFileSync('open', ['-g', '-a', app, '--args', '--socket', sock, '--token', token, '--parent', String(process.pid)])

for (let i = 0; i < 50 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100))
const conn = createConnection(sock)
let buf = ''
const waiters = new Map()
conn.on('data', (d) => {
  buf += d
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, nl))
    buf = buf.slice(nl + 1)
    waiters.get(msg.id)?.(msg)
  }
})
let next = 1
const call = (method, params = {}) =>
  new Promise((res) => {
    const id = next++
    waiters.set(id, res)
    conn.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })

console.log('hello      ', JSON.stringify(await call('hello', { token, protocol: 1 })))
console.log('ping       ', JSON.stringify(await call('ping')))
console.log('permissions', JSON.stringify(await call('permissions')))
conn.end()
await new Promise((r) => setTimeout(r, 500))
console.log('helper exited:', !existsSync(sock))
