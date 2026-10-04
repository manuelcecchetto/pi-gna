// Manual smoke test: launch the built helper through LaunchServices, send ping + permissions, print replies.
// Usage: pnpm build:computer-use && node scripts/computer-use-smoke.mjs
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
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
const apps = await call('list_apps')
const list = apps.result?.apps ?? []
console.log('list_apps  ', list.length, 'apps; running:', list.filter((a) => a.isRunning).map((a) => a.displayName).join(', '))
console.log('denylist   ', JSON.stringify((await call('resolve_app', { app: 'com.apple.Terminal' })).error))

// Launch TextEdit in the background (does not take focus), print the full tree, then a diff after manual typing.
console.log('resolve    ', JSON.stringify(await call('resolve_app', { app: 'TextEdit' })))
const first = await call('get_app_state', { app: 'TextEdit' })
console.log(first.error ? `get_app_state error: ${JSON.stringify(first.error)}` : first.result.text)
console.log('\n>>> Type something into TextEdit, then press Enter here (or wait 20 s)...')
await new Promise((r) => {
  process.stdin.once('data', r)
  setTimeout(r, 20000)
})
const second = await call('get_app_state', { app: 'TextEdit' })
console.log(second.error ? `get_app_state error: ${JSON.stringify(second.error)}` : second.result.text)
// Occlusion check: cover TextEdit with Finder-independent window is manual; capture works either way.
console.log('\n>>> Cover TextEdit with another window now (20 s or Enter) to check background capture...')
await new Promise((r) => {
  process.stdin.once('data', r)
  setTimeout(r, 20000)
})
const shot = await call('screenshot', { app: 'TextEdit' })
if (shot.error) console.log('screenshot error:', JSON.stringify(shot.error))
else {
  const s = shot.result
  const path = '/tmp/pigna-cu-textedit.jpg'
  writeFileSync(path, Buffer.from(s.jpeg, 'base64'))
  console.log(`screenshot saved ${path}: ${s.width}x${s.height}px, window ${s.logicalWidth}x${s.logicalHeight}pt, scale ${s.scale}, regions ${s.regions.length}`)
}
const calc = await call('get_app_state', { app: 'Calculator', disable_diff: true })
console.log(calc.error ? `calculator error: ${JSON.stringify(calc.error)}` : calc.result.text)
process.stdin.pause()
conn.end()
await new Promise((r) => setTimeout(r, 500))
console.log('helper exited:', !existsSync(sock))
