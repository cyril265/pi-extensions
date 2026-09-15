import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { AuditResult } from './audit.ts'
import { npm } from './exec.ts'
import { confirm } from './prompt.ts'
import {
  entrySource,
  getSettingsBaseDir,
  getSettingsPath,
  readSettings,
  resolveLocalSource,
  scopes,
  withSource,
  writeSettings,
  type PackageEntry,
  type Scope,
} from './settings.ts'
import {
  copyTree,
  identityForSource,
  parseSource,
  type FetchedSource,
  type ParsedSource,
  type RemoteSource,
  type Revision,
} from './sources.ts'

export type Manifest = {
  source: string
  identity: string
  installedAt: string
  audit: AuditResult
} & Revision

export type ConfiguredEntry = { scope: Scope; entry: PackageEntry; source: string }
export type ManagedEntry = ConfiguredEntry & {
  settingsPath: string
  baseDir: string
  snapshotPath: string
  manifest: Manifest
}

export function copyToStore(scope: Scope, fetched: FetchedSource, parsed: ParsedSource, audit: AuditResult) {
  const snapshotPath = join(getSettingsBaseDir(scope), 'audited-packages', packageStorePath(parsed))
  mkdirSync(dirname(snapshotPath), { recursive: true })
  rmSync(snapshotPath, { recursive: true, force: true })
  copyTree(fetched.auditPath, snapshotPath)

  const manifest: Manifest = {
    source: parsed.source,
    identity: identityForSource(parsed),
    installedAt: new Date().toISOString(),
    audit,
    ...fetched.revision,
  }
  writeFileSync(manifestPath(snapshotPath), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
  return snapshotPath
}

export function displayLocalSource(scope: Scope, snapshotPath: string) {
  return relative(getSettingsBaseDir(scope), snapshotPath)
}

export async function installSnapshotDependencies(snapshotPath: string) {
  if (!(statSync(snapshotPath).isDirectory() && existsSync(join(snapshotPath, 'package.json')))) {
    return
  }

  console.log(`Installing dependencies in ${snapshotPath}...`)
  npm(['install', '--omit=dev', '--ignore-scripts'], snapshotPath)

  const packageJson = JSON.parse(readFileSync(join(snapshotPath, 'package.json'), 'utf-8')) as {
    scripts?: { postinstall?: string }
  }
  const postinstall = packageJson.scripts?.postinstall
  if (!postinstall) {
    return
  }
  console.log(`Package postinstall script found: ${postinstall}`)
  if (await confirm('Run package postinstall script?')) {
    npm(['run', 'postinstall', '--ignore-scripts'], snapshotPath)
  } else {
    console.log('Skipped package postinstall script.')
  }
}

export function upsertSettingsEntry(scope: Scope, snapshotPath: string, identity: string) {
  const settings = readSettings(scope)
  const localSource = displayLocalSource(scope, snapshotPath)
  const baseDir = getSettingsBaseDir(scope)
  const packages = settings.packages ?? []
  const matches = (entry: PackageEntry) =>
    readManifest(resolveLocalSource(entrySource(entry), baseDir))?.identity === identity
  settings.packages = packages.some(matches)
    ? packages.map(entry => (matches(entry) ? withSource(entry, localSource) : entry))
    : [...packages, localSource]
  writeSettings(scope, settings)
}

export function replaceSettingsSource(scope: Scope, currentSource: string, nextSnapshotPath: string) {
  const settings = readSettings(scope)
  const packages = settings.packages ?? []
  const matches = (entry: PackageEntry) => entrySource(entry) === currentSource
  if (!packages.some(matches)) {
    throw new Error(`Settings entry disappeared: ${currentSource}`)
  }
  const nextSource = displayLocalSource(scope, nextSnapshotPath)
  settings.packages = packages.map(entry => (matches(entry) ? withSource(entry, nextSource) : entry))
  writeSettings(scope, settings)
}

export function findConfiguredEntries(): ConfiguredEntry[] {
  return scopes.flatMap(scope =>
    (readSettings(scope).packages ?? []).map(entry => ({ scope, entry, source: entrySource(entry) })),
  )
}

export function findManagedEntries(): ManagedEntry[] {
  return findConfiguredEntries().flatMap(configured => {
    const baseDir = getSettingsBaseDir(configured.scope)
    const snapshotPath = resolveLocalSource(configured.source, baseDir)
    const manifest = readManifest(snapshotPath)
    if (!manifest) {
      return []
    }
    return [{ ...configured, settingsPath: getSettingsPath(configured.scope), baseDir, snapshotPath, manifest }]
  })
}

export function matchesManagedEntry(input: string, entry: ManagedEntry) {
  const identity = entry.manifest.identity
  return (
    input === entry.source ||
    input === identity.replace(/^(npm|git):/, '') ||
    identityForSource(parseSource(input)) === identity ||
    resolveLocalSource(input, entry.baseDir) === resolve(entry.snapshotPath)
  )
}

export function removeOriginalInstall(scope: Scope, source: RemoteSource) {
  const installRoot = join(getSettingsBaseDir(scope), source.kind)
  if (source.kind === 'npm') {
    if (existsSync(installRoot)) {
      npm(['uninstall', source.name, '--prefix', installRoot], process.cwd())
    }
    return
  }

  const target = join(installRoot, source.host, source.path)
  if (!isInside(target, installRoot)) {
    throw new Error(`Refusing to remove path outside git install root: ${target}`)
  }
  rmSync(target, { recursive: true, force: true })
}

function readManifest(snapshotPath: string): Manifest | undefined {
  if (!existsSync(snapshotPath)) {
    return undefined
  }
  const path = manifestPath(snapshotPath)
  if (!existsSync(path)) {
    return undefined
  }
  const manifest = JSON.parse(readFileSync(path, 'utf-8')) as Manifest
  const valid =
    manifest.kind === 'local' ||
    (manifest.kind === 'npm' && manifest.version && manifest.pinnedSource) ||
    (manifest.kind === 'git' && manifest.gitHead && manifest.pinnedSource)
  if (!valid) {
    throw new Error(`Invalid manifest: ${path}`)
  }
  return manifest
}

function manifestPath(snapshotPath: string) {
  return statSync(snapshotPath).isDirectory()
    ? join(snapshotPath, '.pi-audit.json')
    : `${snapshotPath}.pi-audit.json`
}

function packageStorePath(source: ParsedSource) {
  if (source.kind === 'npm') {
    return join('npm', ...source.name.split('/'))
  }
  if (source.kind === 'git') {
    return join('git', source.host, ...source.path.split('/'))
  }
  return join('local', basename(source.path).replace(/[^a-zA-Z0-9._@-]+/g, '-'))
}

function isInside(path: string, parent: string) {
  const rel = relative(resolve(parent), resolve(path))
  return rel === '' || !(rel.startsWith('..') || isAbsolute(rel))
}
