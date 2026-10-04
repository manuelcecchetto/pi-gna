// Smoke tests for the built helper.
//   node scripts/computer-use-smoke.mjs            launch through LaunchServices, print apps/tree/screenshot (manual steps)
//   node scripts/computer-use-smoke.mjs --fixture  scripted background-input run against a throwaway fixture app under /tmp
//                                                  (no real apps touched; the user's frontmost app, key window, cursor and
//                                                  window order are compared before and after). Spawns the helper binary
//                                                  directly so the invoking terminal's Accessibility/Screen Recording grants
//                                                  apply; add --launchservices to use the granted helper app instead.
// Usage: pnpm build:computer-use && node scripts/computer-use-smoke.mjs [--fixture]
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const fixtureMode = process.argv.includes('--fixture')
let helperProc
if (fixtureMode && !process.argv.includes('--launchservices')) {
  helperProc = spawn(join(app, 'Contents/MacOS/pi-gna Computer Use'), ['--socket', sock, '--token', token, '--parent', String(process.pid)], { stdio: 'ignore' })
} else {
  execFileSync('open', ['-g', '-a', app, '--args', '--socket', sock, '--token', token, '--parent', String(process.pid)])
}

for (let i = 0; i < 50 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100))
const conn = createConnection(sock)
let buf = ''
const waiters = new Map()
const notifications = []
conn.on('data', (d) => {
  buf += d
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, nl))
    buf = buf.slice(nl + 1)
    if (msg.id === undefined) notifications.push(msg)
    else waiters.get(msg.id)?.(msg)
  }
})
let next = 1
const call = (method, params = {}) =>
  new Promise((res) => {
    const id = next++
    waiters.set(id, res)
    conn.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })

if (fixtureMode) {
  await runFixture()
  conn.end()
  helperProc?.kill()
  process.exit(process.exitCode ?? 0)
}
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

// ---- scripted fixture run -------------------------------------------------------------------------------------------

async function runFixture() {
  const work = '/tmp/pigna-cu-fixture'
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const src = join(root, 'native/computer-use/fixture')
  execFileSync('swiftc', ['-O', '-o', join(work, 'desk'), join(src, 'desk.swift')])
  const desk = () => execFileSync(join(work, 'desk'), { encoding: 'utf8' }).trim()
  const fixtures = ['A', 'B'].map((n, i) => {
    const dir = join(work, `Fixture${n}.app/Contents`)
    mkdirSync(join(dir, 'MacOS'), { recursive: true })
    execFileSync('swiftc', ['-O', '-o', join(dir, 'MacOS/Fixture'), join(src, 'Fixture.swift')])
    writeFileSync(join(dir, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.pigna.fixture${n.toLowerCase()}</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleName</key><string>PiFixture${n}</string><key>CFBundlePackageType</key><string>APPL</string><key>NSPrincipalClass</key><string>NSApplication</string></dict></plist>`)
    execFileSync('codesign', ['--force', '--sign', '-', join(work, `Fixture${n}.app`)], { stdio: 'ignore' })
    return { n, bundle: `dev.pigna.fixture${n.toLowerCase()}`, path: join(work, `Fixture${n}.app`), log: join(work, `${n}.log`), x: 120 + i * 700 }
  })
  for (const f of fixtures) {
    // -g: do not activate; no -j so the window stays on screen (hidden windows drop background clicks).
    execFileSync('open', ['-g', '-n', '--env', `FIXTURE_LOG=${f.log}`, '--env', `FIXTURE_X=${f.x}`, f.path])
  }
  for (let i = 0; i < 50 && !fixtures.every((f) => existsSync(f.log)); i++) await new Promise((r) => setTimeout(r, 100))
  await new Promise((r) => setTimeout(r, 800))
  const before = desk()
  console.log('desktop before:', before)

  let failures = 0
  const check = (name, ok, extra = '') => {
    if (!ok) failures++
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
  }
  const [A, B] = fixtures
  const log = (f) => (existsSync(f.log) ? readFileSync(f.log, 'utf8') : '')
  const since = (f, n) => log(f).split('\n').slice(n).join('\n')
  const lines = (f) => log(f).split('\n').length - 1
  // Some effects land after the reply (AppKit button highlight, text changes): poll the fixture log for up to 1.5 s.
  const seen = async (f, n, test) => {
    for (let i = 0; i < 15; i++) {
      const t = since(f, n)
      if (typeof test === 'string' ? t.includes(test) : test.test(t)) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  }
  const idx = (text, re) => {
    const m = new RegExp(`^\\s*\\[(\\d+)\\] ${re}`, 'm').exec(text)
    return m ? Number(m[1]) : undefined
  }
  const SETTLE = { settle_ms: 150 } // keep the scripted run quick; the default 1 s settle is covered by the concurrency check

  console.log('hello      ', JSON.stringify((await call('hello', { token, protocol: 1 })).result))
  console.log('configure  ', JSON.stringify((await call('configure', {})).result))
  const state = async (f, extra = {}) => {
    const r = await call('get_app_state', { app: f.bundle, disable_diff: true, ...extra })
    if (r.error) throw new Error(`get_app_state: ${JSON.stringify(r.error)}`)
    return r.result
  }
  let st = await state(A)
  const screenshotOk = !!st.screenshot
  check('get_app_state returns tree and screenshot', st.text.includes('AXButton "Press"') && screenshotOk, st.screenshotError ?? '')
  const button = idx(st.text, 'AXButton "Press"')
  const checkbox = idx(st.text, 'AXCheckBox "Check"')
  const field = idx(st.text, 'AXTextField')
  const textArea = idx(st.text, 'AXTextArea')
  check('indexes found', [button, checkbox, field, textArea].every((v) => v !== undefined), JSON.stringify({ button, checkbox, field, textArea }))

  let n = lines(A)
  let r = await call('click', { app: A.bundle, element_index: button, ...SETTLE })
  check('click element -> AXPress', r.result?.method === 'ax' && (await seen(A, n, 'ACTION button')), JSON.stringify(r.error ?? r.result))
  n = lines(A)
  r = await call('click', { app: A.bundle, element_index: checkbox, ...SETTLE })
  check('click checkbox by index', (await seen(A, n, 'ACTION checkbox state=1')))

  if (screenshotOk) {
    n = lines(A)
    r = await call('click', { app: A.bundle, x: 60, y: 125, click_count: 2, ...SETTLE })
    check('double click at x,y (synthesized, background)', r.result?.method === 'cgevent' && (await seen(A, n, 'clicks=2')), JSON.stringify(r.error ?? r.result))
    n = lines(A)
    r = await call('click', { app: A.bundle, x: 120, y: 190, mouse_button: 'right', ...SETTLE })
    check('right click at x,y', (await seen(A, n, 'type=3')), JSON.stringify(r.error ?? r.result))
    await call('press_key', { app: A.bundle, key: 'Escape', ...SETTLE })
    n = lines(A)
    r = await call('drag', { app: A.bundle, from_x: 60, from_y: 125, to_x: 120, to_y: 190, ...SETTLE })
    check('drag selects text', (await seen(A, n, /sel=\{\d+, [1-9]/)), JSON.stringify(r.error ?? r.result))
    n = lines(A)
    r = await call('scroll', { app: A.bundle, x: 300, y: 300, direction: 'down', pages: 0.5, ...SETTLE })
    check('scroll down', (await seen(A, n, /scrollY=[1-9]/)), JSON.stringify(r.error ?? r.result))
    n = lines(A)
    r = await call('click', { app: A.bundle, x: 170, y: 70, ...SETTLE })
    check('click text field at x,y', (await seen(A, n, 'type=1')))
  }

  st = await state(A)
  n = lines(A)
  await call('click', { app: A.bundle, element_index: idx(st.text, 'AXTextField'), ...SETTLE }).then(() => {})
  r = await call('type_text', { app: A.bundle, text: 'hello', ...SETTLE })
  check('type_text into the field', (await seen(A, n, "TEXT field='hello'")), JSON.stringify(r.error ?? r.result))
  n = lines(A)
  r = await call('press_key', { app: A.bundle, key: 'BackSpace', ...SETTLE })
  check('press_key BackSpace', (await seen(A, n, "TEXT field='hell'")), JSON.stringify(r.error ?? r.result))

  st = await state(A)
  r = await call('set_value', { app: A.bundle, element_index: idx(st.text, 'AXTextField'), value: 'world', ...SETTLE })
  st = await state(A)
  check('set_value', r.result?.method === 'ax' && st.text.includes('value="world"'), JSON.stringify(r.error ?? r.result))

  const ta = idx(st.text, 'AXTextArea')
  n = lines(A)
  r = await call('select_text', { app: A.bundle, element_index: ta, text: 'line 3', prefix: '', suffix: '\n', ...SETTLE })
  check('select_text', JSON.stringify(r.result?.range) === '[12,6]' || r.result?.range?.[1] === 6, JSON.stringify(r.error ?? r.result))
  r = await call('type_text', { app: A.bundle, text: 'REPLACED', ...SETTLE })
  check('type_text replaces the selection', (await seen(A, n, /TV .*line 2\|REPLACED\|line 4/)), JSON.stringify(r.error ?? r.result))

  n = lines(A)
  r = await call('press_key', { app: A.bundle, key: 'super+a', ...SETTLE })
  check('press_key cmd+a via menu item', r.result?.method === 'ax' && (await seen(A, n, /sel=\{0, [1-9]/)), JSON.stringify(r.error ?? r.result))

  const clip0 = execFileSync('pbpaste', { encoding: 'utf8' })
  n = lines(A)
  r = await call('paste', { app: A.bundle, text: 'PASTED', ...SETTLE })
  check('paste text', await seen(A, n, 'TV PASTED'), JSON.stringify(r.error ?? r.result))
  check('clipboard restored after paste', execFileSync('pbpaste', { encoding: 'utf8' }) === clip0)

  st = await state(A)
  r = await call('perform_secondary_action', { app: A.bundle, element_index: textArea ?? 0, action: 'Bogus', ...SETTLE })
  check('perform_secondary_action lists exposed actions on failure', r.error?.code === -32005 && /Exposed actions/.test(r.error.message), r.error?.message)
  r = await call('click', { app: A.bundle, element_index: 9999 })
  check('stale index -> stale_element', r.error?.code === -32004, r.error?.message)
  r = await call('press_key', { app: A.bundle, key: 'super+j' })
  check('unsupported shortcut -> background_unsupported', r.error?.code === -32011, r.error?.message)
  r = await call('click', { app: 'com.apple.Terminal', x: 1, y: 1 })
  check('denylisted app refused', r.error?.code === -32007, r.error?.message)

  // Concurrency: two apps at once finish in about one settle wait; two actions on one app queue up.
  await state(B)
  const stB = await state(B)
  const btnB = idx(stB.text, 'AXButton "Press"')
  const stA = await state(A)
  const btnA = idx(stA.text, 'AXButton "Press"')
  let t0 = Date.now()
  const both = await Promise.all([call('click', { app: A.bundle, element_index: btnA }), call('click', { app: B.bundle, element_index: btnB })])
  const parallel = Date.now() - t0
  check('two apps are driven concurrently', both.every((x) => !x.error) && parallel < 1800, `${parallel} ms`)
  t0 = Date.now()
  await Promise.all([call('click', { app: A.bundle, element_index: btnA }), call('click', { app: A.bundle, element_index: btnA })])
  const serial = Date.now() - t0
  check('two actions on one app are serialized', serial >= 1900, `${serial} ms`)

  // Overlay: cursor + pill windows are ordered directly above the target window, click-through and not capturable.
  execFileSync('swiftc', ['-O', '-o', join(work, 'wins'), join(src, 'wins.swift')])
  const stack = () => execFileSync(join(work, 'wins'), { encoding: 'utf8' }).trim().split(' ').map((x) => x.split(':').map(Number))
  const helperPid = (await call('hello', { token, protocol: 1 })).result?.pid ?? helperProc?.pid
  const aWin = (await state(A)).windowId
  const show = await call('overlay_show', { app: A.bundle, session_label: 'smoke' })
  check('overlay_show', show.result?.shown === true, JSON.stringify(show.error ?? show.result))
  await call('click', { app: A.bundle, x: 60, y: 125, ...SETTLE })
  await new Promise((r) => setTimeout(r, 500))
  const st1 = stack()
  const mine = st1.filter((w) => w[0] === helperPid)
  const ai = st1.findIndex((w) => w[1] === aWin)
  check('overlay has a cursor and a pill window', mine.length === 2, JSON.stringify(mine))
  check('overlay windows are directly above the target window', ai >= 2 && st1[ai - 1][0] === helperPid && st1[ai - 2][0] === helperPid, `target index ${ai}`)
  check('overlay windows are excluded from captures (sharingState 0)', mine.length > 0 && mine.every((w) => w[3] === 0))
  check('screenshot while overlay is shown is the target window only', !!(await state(A)).screenshot)
  console.log('overlay shown over the fixture for 3 s ...')
  await new Promise((r) => setTimeout(r, 3000))
  const hid = await call('overlay_hide', { app: A.bundle })
  await new Promise((r) => setTimeout(r, 300))
  console.log('hide:', JSON.stringify(hid), 'stack:', JSON.stringify(stack().filter((w) => w[0] === helperPid)))
  check('overlay_hide removes the windows', stack().every((w) => w[0] !== helperPid))
  // Esc cannot be sent without posting a real key event (forbidden on the user's desktop); verify the notification by hand:
  //   node scripts/computer-use-smoke.mjs --fixture --esc   (shows the overlay for 20 s; press Esc while pi-gna/the fixture
  //   is frontmost or the pointer is over the fixture window; prints the cancelled notification)
  if (process.argv.includes('--esc')) {
    await call('overlay_show', { app: A.bundle, session_label: 'smoke' })
    console.log('>>> press Esc now (pointer over the fixture window); waiting 20 s for the cancelled notification')
    for (let i = 0; i < 200 && notifications.length === 0; i++) await new Promise((r) => setTimeout(r, 100))
    await new Promise((r) => setTimeout(r, 1000))
    console.log('notifications:', JSON.stringify(notifications))
    check('Esc produced exactly one cancelled notification', notifications.filter((x) => x.method === 'cancelled').length === 1)
    check('overlay gone after cancel', stack().every((w) => w[0] !== helperPid))
  }

  const after = desk()
  console.log('desktop after: ', after)
  check('frontmost app, key window, cursor and window order unchanged', before === after)
  // Only the fixtures this run launched are terminated.
  for (const f of fixtures) {
    try {
      execFileSync('pkill', ['-f', `${f.path}/Contents/MacOS/Fixture`])
    } catch {}
  }
  console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
}
