// Renders the Computer Use overlay (glow frame, pigna pointer, click ripple, pill) over a sample window and saves
// screenshots, to check its look without driving an app: node scripts/computer-use-overlay-preview.mjs [parentDir] (creates a unique subdirectory)
// Shows a floating window on screen for about 3 s; screencapture needs Screen Recording for the terminal.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'native/computer-use/Sources')
const parent = resolve(process.argv[2] ?? tmpdir())
mkdirSync(parent, { recursive: true })
const out = mkdtempSync(join(parent, 'pigna-overlay-preview-'))
const app = join(out, 'OverlayPreview.app/Contents')
mkdirSync(join(app, 'MacOS'), { recursive: true })
mkdirSync(join(app, 'Resources'))
cpSync(join(root, 'src/renderer/src/assets/pigna-hand.svg'), join(app, 'Resources/pigna-hand.svg'))
writeFileSync(join(app, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.pigna.overlaypreview</string><key>CFBundleExecutable</key><string>preview</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
const files = readdirSync(src).filter((f) => f.endsWith('.swift') && f !== 'main.swift').map((f) => join(src, f))
// Top-level code is only allowed in main.swift.
cpSync(join(root, 'native/computer-use/fixture/overlay-preview.swift'), join(out, 'main.swift'))
execFileSync('swiftc', ['-o', join(app, 'MacOS/preview'), ...files, join(out, 'main.swift')], { stdio: 'inherit' })
execFileSync(join(app, 'MacOS/preview'), ['--out', out], { stdio: 'inherit' })
