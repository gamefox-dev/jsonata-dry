// Builds the published library (the dry-run engine only) into ./lib: ESM + .d.ts.
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

rmSync('lib', { recursive: true, force: true })

const tsc = Bun.spawnSync(['bunx', 'tsc', '-p', 'tsconfig.lib.json'], {
  stdout: 'inherit',
  stderr: 'inherit',
})
if (tsc.exitCode !== 0) process.exit(tsc.exitCode ?? 1)

// tsc leaves `./x.ts` in some inline `import { type … }` declarations; consumers only have `./x.js`
for (const f of readdirSync('lib')) {
  if (!f.endsWith('.d.ts')) continue
  const p = join('lib', f)
  const src = readFileSync(p, 'utf8')
  const out = src.replace(/(from\s+['"]\.\/[\w-]+)\.ts(['"])/g, '$1.js$2')
  if (out !== src) writeFileSync(p, out)
}
console.log('lib built:', readdirSync('lib').join(', '))
