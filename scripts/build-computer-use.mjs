// Builds "pi-gna Computer Use.app" (universal, ad-hoc signed) from native/computer-use/ into build/computer-use/.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'native/computer-use/Sources')
const out = join(root, 'build/computer-use')
const appName = 'pi-gna Computer Use'
const app = join(out, `${appName}.app`)
const bundleId = 'io.github.manuelcecchetto.pigna.computeruse'

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
// PigCUHelperVersion is the single source of truth for reinstall decisions: read the constant from Swift.
const helperVersion = /let helperVersion = (\d+)/.exec(readFileSync(join(src, 'Protocol.swift'), 'utf8'))?.[1]
if (!helperVersion) throw new Error('helperVersion constant not found in Protocol.swift')

const files = readdirSync(src).filter((f) => f.endsWith('.swift')).map((f) => join(src, f))
rmSync(out, { recursive: true, force: true })
mkdirSync(join(app, 'Contents/MacOS'), { recursive: true })
mkdirSync(join(out, 'obj'), { recursive: true })

const archs = ['arm64', 'x86_64']
const slices = archs.map((arch) => {
  const bin = join(out, 'obj', arch)
  execFileSync(
    'swiftc',
    ['-O', '-target', `${arch}-apple-macos14.0`, '-o', bin, ...files],
    { stdio: 'inherit' }
  )
  return bin
})
execFileSync('lipo', ['-create', ...slices, '-output', join(app, 'Contents/MacOS', appName)])
rmSync(join(out, 'obj'), { recursive: true, force: true })

writeFileSync(
  join(app, 'Contents/Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
  <key>CFBundleName</key><string>${appName}</string>
  <key>CFBundleDisplayName</key><string>${appName}</string>
  <key>CFBundleExecutable</key><string>${appName}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>${helperVersion}</string>
  <key>CFBundleShortVersionString</key><string>${pkg.version}</string>
  <key>PigCUHelperVersion</key><integer>${helperVersion}</integer>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAccessibilityUsageDescription</key><string>pi-gna Computer Use reads and operates apps you approve so the pi agent can work in them.</string>
  <key>NSScreenCaptureUsageDescription</key><string>pi-gna Computer Use captures screenshots of apps you approve so the pi agent can see them.</string>
</dict>
</plist>
`
)

execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
console.log(app)
