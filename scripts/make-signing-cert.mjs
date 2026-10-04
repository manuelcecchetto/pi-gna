// Creates the self-signed code-signing certificate release.yml signs the Computer Use helper with (docs/DESIGN.md,
// "Signing"). macOS keys Accessibility and Screen Recording grants to the helper's designated requirement, which
// for this certificate is its bundle id plus the certificate's hash, so grants survive every release signed with it.
// Run once; a new certificate makes every user grant both permissions again. Writes the key outside the repo and
// prints the two GitHub secrets to set.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = process.argv[2] ?? join(homedir(), '.config', 'pi-gna', 'signing')
const p12 = join(dir, 'pi-gna-signing.p12')
if (existsSync(p12)) {
  console.error(`${p12} already exists. Replacing it resets every user's Computer Use grants; delete it first if you mean to.`)
  process.exit(1)
}
mkdirSync(dir, { recursive: true, mode: 0o700 })

const config = join(dir, 'cert.cnf')
writeFileSync(
  config,
  `[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=pi-gna Code Signing
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
`
)
const key = join(dir, 'key.pem')
const cert = join(dir, 'cert.pem')
const password = randomBytes(24).toString('base64url')
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-keyout', key, '-out', cert, '-days', '7300', '-config', config], { stdio: 'ignore' })
// -legacy: macOS `security import` cannot read OpenSSL 3's default PKCS#12 encryption.
const exportArgs = ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', p12, '-name', 'pi-gna Code Signing', '-passout', `pass:${password}`]
try {
  execFileSync('openssl', [...exportArgs, '-legacy'], { stdio: 'ignore' })
} catch {
  execFileSync('openssl', exportArgs, { stdio: 'ignore' })
}
execFileSync('rm', ['-f', key, config])
writeFileSync(join(dir, 'password.txt'), `${password}\n`, { mode: 0o600 })
execFileSync('chmod', ['600', p12])

const sha1 = execFileSync('openssl', ['x509', '-in', cert, '-noout', '-fingerprint', '-sha1'], { encoding: 'utf8' }).split('=')[1].replaceAll(':', '').trim()
console.log(`Certificate SHA-1 ${sha1}, written to ${dir} (keep the .p12 and password.txt safe).`)
console.log('Set the release secrets:')
console.log(`  base64 -i "${p12}" | gh secret set SIGNING_CERT_P12`)
console.log(`  gh secret set SIGNING_CERT_PASSWORD < "${join(dir, 'password.txt')}"`)
