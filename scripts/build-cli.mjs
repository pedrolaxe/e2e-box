// Gera dist/cli.js: a CLI (bin/e2e-box.ts + src/lib) num arquivo só, com yaml e fast-xml-parser
// dentro, para o pacote do npm não ter dependências. O painel (Next) não entra no pacote.
import { build } from 'esbuild'
import fs from 'node:fs'

fs.rmSync('dist', { recursive: true, force: true })
await build({
  entryPoints: ['bin/e2e-box.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  target: 'node18',
  // CommonJS: a CLI usa __dirname para achar a pasta do pacote (agent/dist/e2e-box-agent.jar).
  format: 'cjs',
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  logLevel: 'info',
})
fs.chmodSync('dist/cli.js', 0o755)
