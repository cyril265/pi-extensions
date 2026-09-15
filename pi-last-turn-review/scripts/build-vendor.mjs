import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const here = path => fileURLToPath(new URL(path, import.meta.url))
const shikiShim = {
  name: 'shiki-shim',
  setup(build) {
    build.onResolve({ filter: /^shiki$/ }, () => ({ path: here('./shiki-shim.js') }))
  },
}
const common = { bundle: true, minify: true, format: 'iife', platform: 'browser', target: 'es2022', plugins: [shikiShim], logLevel: 'warning' }

await esbuild.build({ ...common, entryPoints: [here('./vendor-entry.js')], globalName: 'PierreDiffs', outfile: here('../web/vendor/diffs.js') })
await esbuild.build({ ...common, entryPoints: ['@pierre/diffs/worker/worker.js'], outfile: here('../web/vendor/diffs-worker.js') })
await esbuild.build({ ...common, plugins: [], entryPoints: ['markdown-it'], globalName: 'markdownit', outfile: here('../web/vendor/markdown-it.js') })
const tailwindCli = fileURLToPath(new URL('./dist/index.mjs', import.meta.resolve('@tailwindcss/cli/package.json')))
execFileSync(process.execPath, [tailwindCli, '--input', here('../web/styles.css'), '--output', here('../web/vendor/styles.css'), '--minify'], { stdio: 'inherit' })
