import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export type Scope = 'global' | 'project'
export const scopes: Scope[] = ['project', 'global']

export type PackageEntry =
  | string
  | {
      source: string
      extensions?: string[]
      skills?: string[]
      prompts?: string[]
      themes?: string[]
    }

export type Settings = {
  npmCommand?: string[]
  packages?: PackageEntry[]
}

export function readSettings(scope: Scope): Settings {
  const path = getSettingsPath(scope)
  if (!existsSync(path)) {
    return {}
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as Settings
}

export function writeSettings(scope: Scope, settings: Settings) {
  const path = getSettingsPath(scope)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
}

export function getSettingsPath(scope: Scope) {
  return join(getSettingsBaseDir(scope), 'settings.json')
}

export function getSettingsBaseDir(scope: Scope) {
  return scope === 'project' ? join(process.cwd(), '.pi') : getAgentDir()
}

export function getAgentDir() {
  const envDir = process.env.PI_CODING_AGENT_DIR
  return envDir ? expandHome(envDir) : join(homedir(), '.pi', 'agent')
}

export function entrySource(entry: PackageEntry) {
  return typeof entry === 'string' ? entry : entry.source
}

export function withSource(entry: PackageEntry, source: string): PackageEntry {
  return typeof entry === 'string' ? source : { ...entry, source }
}

export function resolveLocalSource(source: string, baseDir: string) {
  const expanded = expandHome(source.trim())
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded)
}

function expandHome(path: string) {
  if (path === '~') {
    return homedir()
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2))
  }
  return path
}
