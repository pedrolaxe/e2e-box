// Compila o agente do celular: javac (contra o android.jar do SDK) + d8 -> agent/dist/e2e-box-agent.jar.
// Uso: node agent/build.mjs   (precisa de JDK 17+ e Android SDK com build-tools e platforms)
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk')
const latest = (dir) => fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop()
const platform = latest(path.join(sdk, 'platforms'))
const buildTools = latest(path.join(sdk, 'build-tools'))
const androidJar = path.join(sdk, 'platforms', platform, 'android.jar')
const d8 = path.join(sdk, 'build-tools', buildTools, process.platform === 'win32' ? 'd8.bat' : 'd8')

const classes = path.join(here, 'build', 'classes')
const dist = path.join(here, 'dist')
fs.rmSync(path.join(here, 'build'), { recursive: true, force: true })
fs.mkdirSync(classes, { recursive: true })
fs.mkdirSync(dist, { recursive: true })

const sources = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (p.endsWith('.java')) sources.push(p)
  }
}
walk(path.join(here, 'src'))

console.log(`javac (${platform}) ...`)
execFileSync('javac', ['--release', '11', '-cp', androidJar, '-d', classes, ...sources], { stdio: 'inherit' })

const classFiles = []
const walkClasses = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkClasses(p)
    else if (p.endsWith('.class')) classFiles.push(p)
  }
}
walkClasses(classes)

const out = path.join(dist, 'e2e-box-agent.jar')
console.log(`d8 (${buildTools}) ...`)
execFileSync(d8, ['--min-api', '28', '--lib', androidJar, '--output', out, ...classFiles], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
fs.rmSync(path.join(here, 'build'), { recursive: true, force: true })
console.log(`ok: ${path.relative(process.cwd(), out)} (${fs.statSync(out).size} bytes)`)
