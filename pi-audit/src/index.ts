#!/usr/bin/env node

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import crossSpawn from 'cross-spawn'

type Scope = 'global' | 'project'
type SourceKind = 'npm' | 'git' | 'local'
type Recommendation = 'yes' | 'no' | 'maybe'
type AuditDecision = 'yes' | 'no' | 'ask'
type PackageEntry =
  | string
  | {
      source: string
      extensions?: string[]
      skills?: string[]
      prompts?: string[]
      themes?: string[]
    }
type Settings = {
  npmCommand?: string[]
  packages?: PackageEntry[]
}
type ParsedSource =
  | { kind: 'npm'; source: string; spec: string; name: string; pinned: boolean }
  | {
      kind: 'git'
      source: string
      repo: string
      host: string
      path: string
      ref?: string
      pinned: boolean
    }
  | { kind: 'local'; source: string; path: string; pinned: false }
type AuditResult = { recommendation: Recommendation; report: string }
type FetchedSource = { auditPath: string; version?: string; gitHead?: string }
type Manifest = {
  source: string
  kind: SourceKind
  identity: string
  installedAt: string
  audit: AuditResult
  version?: string
  gitHead?: string
}
type ConfiguredEntry = {
  scope: Scope
  entry: PackageEntry
  source: string
}
type ManagedEntry = ConfiguredEntry & {
  settingsPath: string
  baseDir: string
  snapshotPath: string
  manifest: Manifest
}
type UpdatableSource = Exclude<ParsedSource, { kind: 'local' }>
type UpdateCandidate = { entry: ManagedEntry; parsed: UpdatableSource }
type FetchedUpdate = UpdateCandidate & { fetched: FetchedSource; resolvedSource: string }
type AuditedUpdate = FetchedUpdate & { audit: AuditResult }
type UpdateFailureStage = 'check' | 'fetch' | 'audit'
type PendingUpdateAudit = UpdateCandidate & { status: 'pending' }
type SuccessfulUpdateAudit = AuditedUpdate & { status: 'audited' }
type FailedUpdateAudit = {
  status: 'failed'
  entry: ManagedEntry
  stage: UpdateFailureStage
  error: string
  fetched?: FetchedSource
  resolvedSource?: string
}
type UpdateAuditOutcome = SuccessfulUpdateAudit | FailedUpdateAudit
type UpdateRevision = { source: string; version?: string; gitHead?: string }
type UpdateAuditReportEntry = {
  status: 'audited' | 'failed'
  scope: Scope
  identity: string
  source: string
  settingsSource: string
  settingsPath: string
  snapshotPath: string
  current: UpdateRevision
  candidate?: UpdateRevision
  audit?: AuditResult
  failure?: { stage: UpdateFailureStage; message: string }
}
type UpdateAuditRunReport = {
  reportVersion: 1
  command: 'update' | 'update-all'
  generatedAt: string
  summary: {
    managed: number
    available: number
    audited: number
    failed: number
    current: number
    skipped: number
  }
  updates: UpdateAuditReportEntry[]
}

const command = process.argv[2]
const args = process.argv.slice(3)

if (!command || command === '-h' || command === '--help') {
  usage()
  process.exit(command ? 0 : 1)
}

try {
  if (command === 'install') {
    await installCommand(args)
  } else if (command === 'update') {
    if (args.length === 0) {
      await updateAllCommand(args)
    } else {
      await updateCommand(args)
    }
  } else if (command === 'update-all') {
    await updateAllCommand(args)
  } else if (command === 'migrate') {
    await migrateCommand(args)
  } else {
    usage()
    process.exit(1)
  }
} catch (error) {
  const message = errorMessage(error)
  console.error(`Error: ${message}`)
  process.exit(1)
}

function usage() {
  console.log(`Usage:
  pi-audit install <source> [-l|--local]
  pi-audit update [package]
  pi-audit update-all
  pi-audit migrate

Sources match pi install: npm:, git:, raw git URLs, local paths.`)
}

async function installCommand(rawArgs: string[]) {
  const { source, local } = parseInstallArgs(rawArgs)
  const scope: Scope = local ? 'project' : 'global'
  const parsed = parseSource(source)
  const fetched = fetchSource(parsed)
  const audit = auditPackage(source, fetched.auditPath)
  printAudit(source, audit)

  if (!(await confirmAuditDecision('Install?', source, fetched, audit))) {
    console.log('Skipped.')
    return
  }

  const snapshotPath = copyToStore(scope, fetched, source, audit, parsed)
  await installSnapshotDependencies(snapshotPath, parsed)
  upsertSettingsEntry(scope, snapshotPath, identityForSource(parsed))
  console.log(`Installed audited snapshot: ${displayLocalSource(scope, snapshotPath)}`)
}

async function updateCommand(rawArgs: string[]) {
  if (rawArgs.length !== 1) {
    throw new Error('Usage: pi-audit update [package]')
  }

  const matches = findManagedEntries().filter(entry => matchesManagedEntry(rawArgs[0], entry))
  if (matches.length === 0) {
    throw new Error(`No managed package found for ${rawArgs[0]}`)
  }

  for (const entry of matches) {
    await updateManagedEntry(entry)
  }
}

async function updateAllCommand(rawArgs: string[]) {
  if (rawArgs.length !== 0) {
    throw new Error('Usage: pi-audit update-all')
  }

  const entries = findManagedEntries()
  if (entries.length === 0) {
    console.log('No managed packages found.')
    return
  }

  let skipped = 0
  let current = 0
  let available = 0
  const workItems: (PendingUpdateAudit | FailedUpdateAudit)[] = []
  for (const entry of entries) {
    let parsed: ParsedSource
    try {
      parsed = parseSource(entry.manifest.source)
    } catch (error) {
      workItems.push(createFailedUpdateAudit(entry, 'check', error))
      continue
    }

    if (parsed.kind === 'local' || parsed.pinned) {
      skipped += 1
      continue
    }

    try {
      if (hasAvailableUpdate(entry, parsed)) {
        available += 1
        workItems.push({ status: 'pending', entry, parsed })
      } else {
        current += 1
      }
    } catch (error) {
      workItems.push(createFailedUpdateAudit(entry, 'check', error))
    }
  }

  const checkFailures = workItems.filter(item => item.status === 'failed').length
  console.log(
    `${entries.length} managed package(s), ${available} update(s) available, ${current} current, ${skipped} skipped${checkFailures > 0 ? `, ${checkFailures} failed check(s)` : ''}.`,
  )

  if (workItems.length === 0) {
    return
  }

  const outcomes: UpdateAuditOutcome[] = []
  for (const item of workItems) {
    if (item.status === 'failed') {
      outcomes.push(item)
    } else {
      outcomes.push(auditUpdateWorkItem(item))
    }
  }

  const successfulUpdates = outcomes.filter(isSuccessfulUpdateAudit)
  const failedUpdates = outcomes.filter(isFailedUpdateAudit)
  const reportPath = saveUpdateAuditRunReport({
    reportVersion: 1,
    command: updateAuditCommand(),
    generatedAt: new Date().toISOString(),
    summary: {
      managed: entries.length,
      available,
      audited: successfulUpdates.length,
      failed: failedUpdates.length,
      current,
      skipped,
    },
    updates: outcomes.map(updateAuditReportEntry),
  })

  printUpdateAuditSummary(outcomes, reportPath)

  if (successfulUpdates.length === 0) {
    console.log('No successful audits to review.')
    reportUpdateFailures(failedUpdates, reportPath)
    return
  }

  console.log('Reviewing audited updates.')
  const approvedUpdates: AuditedUpdate[] = []
  for (let index = 0; index < successfulUpdates.length; index += 1) {
    const auditedUpdate = successfulUpdates[index]
    printUpdateReview(index + 1, successfulUpdates.length, auditedUpdate)
    if (
      await confirmAuditDecision(
        'Update?',
        auditedUpdate.entry.manifest.source,
        auditedUpdate.fetched,
        auditedUpdate.audit,
      )
    ) {
      approvedUpdates.push(auditedUpdate)
    } else {
      console.log('Skipped.')
    }
  }

  for (const approvedUpdate of approvedUpdates) {
    await applyManagedUpdate(approvedUpdate)
  }

  reportUpdateFailures(failedUpdates, reportPath)
}

async function migrateCommand(rawArgs: string[]) {
  if (rawArgs.length !== 0) {
    throw new Error('Usage: pi-audit migrate')
  }

  const entries = findMigratableEntries()
  if (entries.length === 0) {
    console.log('No npm/git packages to migrate.')
    return
  }

  console.log(`${entries.length} package(s) to migrate.`)
  for (const entry of entries) {
    await migrateEntry(entry)
  }
}

async function migrateEntry(entry: ConfiguredEntry) {
  const parsed = parseSource(entry.source) as Exclude<ParsedSource, { kind: 'local' }>
  const fetched = fetchSource(parsed)
  const audit = auditPackage(entry.source, fetched.auditPath)
  printAudit(entry.source, audit)

  if (!(await confirmAuditDecision('Migrate?', entry.source, fetched, audit))) {
    console.log('Skipped.')
    return
  }

  const snapshotPath = copyToStore(entry.scope, fetched, entry.source, audit, parsed)
  await installSnapshotDependencies(snapshotPath, parsed)
  replaceSettingsSource(entry.scope, entry.source, snapshotPath)
  removeOriginalInstall(entry.scope, parsed)
  console.log(`Migrated audited snapshot: ${displayLocalSource(entry.scope, snapshotPath)}`)
}

async function updateManagedEntry(entry: ManagedEntry) {
  const parsed = parseSource(entry.manifest.source)
  if (parsed.kind === 'local' || parsed.pinned) {
    console.log(`${entry.manifest.source} pinned/local, skipped.`)
    return
  }
  if (!hasAvailableUpdate(entry, parsed)) {
    console.log(`${entry.manifest.source} is current.`)
    return
  }

  const auditedUpdate = auditManagedUpdate(entry, parsed)
  printAudit(entry.manifest.source, auditedUpdate.audit)

  if (
    !(
      await confirmAuditDecision(
        'Update?',
        entry.manifest.source,
        auditedUpdate.fetched,
        auditedUpdate.audit,
      )
    )
  ) {
    console.log('Skipped.')
    return
  }

  await applyManagedUpdate(auditedUpdate)
}

function auditManagedUpdate(entry: ManagedEntry, parsed: UpdatableSource): AuditedUpdate {
  return auditFetchedManagedUpdate(fetchManagedUpdate(entry, parsed))
}

function fetchManagedUpdate(entry: ManagedEntry, parsed: UpdatableSource): FetchedUpdate {
  const fetched = fetchSource(parsed)
  const resolvedSource = resolvedUpdateSource(parsed, fetched)
  return { entry, parsed, fetched, resolvedSource }
}

function auditFetchedManagedUpdate(update: FetchedUpdate): AuditedUpdate {
  const audit = auditPackage(update.entry.manifest.source, update.fetched.auditPath)
  return { ...update, audit }
}

function auditUpdateWorkItem(item: PendingUpdateAudit): UpdateAuditOutcome {
  let fetchedUpdate: FetchedUpdate | undefined
  let stage: UpdateFailureStage = 'fetch'
  try {
    fetchedUpdate = fetchManagedUpdate(item.entry, item.parsed)
    stage = 'audit'
    return { ...auditFetchedManagedUpdate(fetchedUpdate), status: 'audited' }
  } catch (error) {
    return createFailedUpdateAudit(item.entry, stage, error, fetchedUpdate)
  }
}

function createFailedUpdateAudit(
  entry: ManagedEntry,
  stage: UpdateFailureStage,
  error: unknown,
  fetchedUpdate?: FetchedUpdate,
): FailedUpdateAudit {
  return {
    status: 'failed',
    entry,
    stage,
    error: errorMessage(error),
    fetched: fetchedUpdate?.fetched,
    resolvedSource: fetchedUpdate?.resolvedSource,
  }
}

function resolvedUpdateSource(parsed: UpdatableSource, fetched: FetchedSource) {
  if (parsed.kind === 'npm') {
    if (!fetched.version) {
      throw new Error(`Fetched npm package has no version: ${parsed.source}`)
    }
    return `npm:${parsed.name}@${fetched.version}`
  }

  if (!fetched.gitHead) {
    throw new Error(`Fetched git package has no commit: ${parsed.source}`)
  }
  return `${parsed.source}@${fetched.gitHead}`
}

async function applyManagedUpdate(update: AuditedUpdate) {
  const nextSnapshotPath = copyToStore(
    update.entry.scope,
    update.fetched,
    update.entry.manifest.source,
    update.audit,
    update.parsed,
  )
  await installSnapshotDependencies(nextSnapshotPath, update.parsed)
  replaceSettingsSource(update.entry.scope, update.entry.source, nextSnapshotPath)
  console.log(
    `Updated audited snapshot: ${displayLocalSource(update.entry.scope, nextSnapshotPath)}`,
  )
}

function saveUpdateAuditRunReport(report: UpdateAuditRunReport) {
  const runsDir = join(getSettingsBaseDir('project'), 'audit-runs')
  mkdirSync(runsDir, { recursive: true })
  const safeTimestamp = report.generatedAt.replace(/[:.]/g, '-')
  const reportPath = join(runsDir, `${safeTimestamp}.json`)
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  return reportPath
}

function updateAuditCommand(): 'update' | 'update-all' {
  return command === 'update' ? 'update' : 'update-all'
}

function updateAuditReportEntry(outcome: UpdateAuditOutcome): UpdateAuditReportEntry {
  const base = {
    scope: outcome.entry.scope,
    identity: outcome.entry.manifest.identity,
    source: outcome.entry.manifest.source,
    settingsSource: outcome.entry.source,
    settingsPath: outcome.entry.settingsPath,
    snapshotPath: outcome.entry.snapshotPath,
    current: currentRevision(outcome.entry),
  }

  if (outcome.status === 'audited') {
    return {
      status: 'audited',
      ...base,
      candidate: candidateRevision(outcome.resolvedSource, outcome.fetched),
      audit: outcome.audit,
    }
  }

  return {
    status: 'failed',
    ...base,
    candidate: outcome.resolvedSource
      ? candidateRevision(outcome.resolvedSource, outcome.fetched)
      : undefined,
    failure: { stage: outcome.stage, message: outcome.error },
  }
}

function currentRevision(entry: ManagedEntry): UpdateRevision {
  const revision: UpdateRevision = { source: entry.manifest.source }
  if (entry.manifest.version) {
    revision.version = entry.manifest.version
  }
  if (entry.manifest.gitHead) {
    revision.gitHead = entry.manifest.gitHead
  }
  return revision
}

function candidateRevision(source: string, fetched: FetchedSource | undefined): UpdateRevision {
  const revision: UpdateRevision = { source }
  if (fetched?.version) {
    revision.version = fetched.version
  }
  if (fetched?.gitHead) {
    revision.gitHead = fetched.gitHead
  }
  return revision
}

function printUpdateAuditSummary(outcomes: UpdateAuditOutcome[], reportPath: string) {
  console.log(`Audit report saved: ${displayProjectPath(reportPath)}`)
  console.log('Audit summary:')
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index]
    const prefix = `${index + 1}. [${outcome.entry.scope}] ${outcome.entry.manifest.identity}`
    if (outcome.status === 'audited') {
      console.log(
        `${prefix}: ${formatCurrentRevision(outcome.entry)} → ${formatCandidateRevision(outcome.resolvedSource, outcome.fetched)}; ${outcome.audit.recommendation} — ${outcome.audit.report}`,
      )
    } else {
      const candidate = outcome.resolvedSource
        ? ` → ${formatCandidateRevision(outcome.resolvedSource, outcome.fetched)}`
        : ''
      console.log(`${prefix}${candidate}: failed during ${outcome.stage} — ${outcome.error}`)
    }
  }
}

function printUpdateReview(index: number, total: number, update: AuditedUpdate) {
  console.log(`\n[${index}/${total}] ${update.entry.manifest.identity}`)
  console.log(`Source: ${update.entry.manifest.source}`)
  console.log(`Current: ${formatCurrentRevision(update.entry)}`)
  console.log(`Candidate: ${formatCandidateRevision(update.resolvedSource, update.fetched)}`)
  console.log(`Audit: ${update.audit.recommendation} — ${update.audit.report}`)
}

function reportUpdateFailures(failedUpdates: FailedUpdateAudit[], reportPath: string) {
  if (failedUpdates.length === 0) {
    return
  }
  console.error(
    `${failedUpdates.length} update check/audit(s) failed. See ${displayProjectPath(reportPath)}.`,
  )
  process.exitCode = 1
}

function isSuccessfulUpdateAudit(outcome: UpdateAuditOutcome): outcome is SuccessfulUpdateAudit {
  return outcome.status === 'audited'
}

function isFailedUpdateAudit(outcome: UpdateAuditOutcome): outcome is FailedUpdateAudit {
  return outcome.status === 'failed'
}

function formatCurrentRevision(entry: ManagedEntry) {
  if (entry.manifest.version) {
    return entry.manifest.version
  }
  if (entry.manifest.gitHead) {
    return shortGitHead(entry.manifest.gitHead)
  }
  return entry.manifest.source
}

function formatCandidateRevision(source: string, fetched: FetchedSource | undefined) {
  if (fetched?.version) {
    return `${fetched.version} (${source})`
  }
  if (fetched?.gitHead) {
    return `${shortGitHead(fetched.gitHead)} (${source})`
  }
  return source
}

function shortGitHead(gitHead: string) {
  return gitHead.slice(0, 12)
}

function displayProjectPath(path: string) {
  const rel = relative(process.cwd(), path)
  if (rel && !(rel.startsWith('..') || isAbsolute(rel))) {
    return rel
  }
  return path
}

function parseInstallArgs(rawArgs: string[]) {
  let local = false
  let source: string | undefined
  for (const arg of rawArgs) {
    if (arg === '-l' || arg === '--local') {
      local = true
    } else if (source) {
      throw new Error(`Unexpected argument: ${arg}`)
    } else {
      source = arg
    }
  }
  if (!source) {
    throw new Error('Usage: pi-audit install <source> [-l|--local]')
  }
  return { source, local }
}

function fetchSource(source: ParsedSource) {
  const root = mkdtempSync(join(tmpdir(), 'pi-audit-'))
  if (source.kind === 'npm') {
    return fetchNpm(source, root)
  }
  if (source.kind === 'git') {
    return fetchGit(source, root)
  }
  return fetchLocal(source, root)
}

function fetchNpm(source: Extract<ParsedSource, { kind: 'npm' }>, root: string) {
  const commandParts = npmCommand()
  const executable = commandParts[0]
  if (!executable) {
    throw new Error('Invalid npmCommand: empty command')
  }
  run(
    executable,
    [...commandParts.slice(1), 'pack', source.spec, '--pack-destination', root, '--json'],
    process.cwd(),
  )
  const tarball = readdirSync(root).find(file => file.endsWith('.tgz'))
  if (!tarball) {
    throw new Error(`npm pack did not produce tarball for ${source.source}`)
  }
  run('tar', ['-xzf', join(root, tarball), '-C', root], process.cwd())
  const auditPath = join(root, 'package')
  if (!existsSync(auditPath)) {
    throw new Error(`npm tarball has no package directory: ${source.source}`)
  }
  return { auditPath, version: readNpmPackageVersion(auditPath) }
}

function fetchGit(source: Extract<ParsedSource, { kind: 'git' }>, root: string) {
  const auditPath = join(root, 'repo')
  run('git', ['clone', source.repo, auditPath], process.cwd(), { GIT_TERMINAL_PROMPT: '0' })
  if (source.ref) {
    run('git', ['checkout', source.ref], auditPath)
  }
  const gitHead = run('git', ['rev-parse', 'HEAD'], auditPath).trim()
  return { auditPath, gitHead }
}

function fetchLocal(source: Extract<ParsedSource, { kind: 'local' }>, root: string) {
  const resolved = resolveLocalSource(source.path, process.cwd())
  if (!existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`)
  }
  const stat = statSync(resolved)
  const auditPath = join(root, basename(resolved))
  if (stat.isDirectory()) {
    cpSync(resolved, auditPath, { recursive: true, dereference: false, filter: shouldCopyPath })
  } else {
    copyFileSync(resolved, auditPath)
  }
  return { auditPath }
}

function auditPackage(source: string, auditPath: string): AuditResult {
  console.log(`Auditing ${source}...`)
  const prompt = `You are auditing a Pi package before install.

Source: ${source}
Path: ${auditPath}

Use only read/search/list tools. Do not execute package code. Check extensions, skills, prompts, themes, package.json scripts, dependency risk, credential/network/file access, obfuscation, and install-time surprises.

Return ONLY compact JSON matching this schema:
{"recommendation":"yes|no|maybe","report":"max 200 chars"}`

  const result = crossSpawn.sync(
    'pi',
    [
      '-p',
      '--provider',
      'openai-codex',
      '--model',
      'gpt-5.6-sol',
      '--thinking',
      'medium',
      '--no-session',
      '--no-context-files',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--tools',
      'read,grep,find,ls',
      prompt,
    ],
    { encoding: 'utf-8', cwd: process.cwd() },
  )

  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `pi audit failed with status ${result.status}`)
  }

  return parseAuditResult(result.stdout)
}

function parseAuditResult(outputText: string): AuditResult {
  const match = outputText.match(/\{[\s\S]*\}/)
  if (!match) {
    throw new Error(`Pi audit returned no JSON: ${outputText.trim()}`)
  }

  const parsed = JSON.parse(match[0]) as Partial<AuditResult>
  if (
    parsed.recommendation !== 'yes' &&
    parsed.recommendation !== 'no' &&
    parsed.recommendation !== 'maybe'
  ) {
    throw new Error('Pi audit JSON has invalid recommendation')
  }
  if (typeof parsed.report !== 'string' || parsed.report.length === 0) {
    throw new Error('Pi audit JSON has invalid report')
  }

  return {
    recommendation: parsed.recommendation,
    report: parsed.report,
  }
}

function copyToStore(
  scope: Scope,
  fetched: FetchedSource,
  source: string,
  audit: AuditResult,
  parsed: ParsedSource,
) {
  const auditPath = fetched.auditPath
  const storeRoot = getStoreRoot(scope)
  mkdirSync(storeRoot, { recursive: true })

  const snapshotPath = getSnapshotPath(scope, parsed)
  mkdirSync(dirname(snapshotPath), { recursive: true })
  if (existsSync(snapshotPath)) {
    rmSync(snapshotPath, { recursive: true, force: true })
  }

  const stat = statSync(auditPath)
  if (stat.isDirectory()) {
    cpSync(auditPath, snapshotPath, { recursive: true, dereference: false, filter: shouldCopyPath })
  } else {
    copyFileSync(auditPath, snapshotPath)
  }

  const manifest: Manifest = {
    source,
    kind: parsed.kind,
    identity: identityForSource(parsed),
    installedAt: new Date().toISOString(),
    audit,
    version: fetched.version,
    gitHead: fetched.gitHead,
  }
  const manifestPath = stat.isDirectory()
    ? join(snapshotPath, '.pi-audit.json')
    : `${snapshotPath}.pi-audit.json`
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
  return snapshotPath
}

async function installSnapshotDependencies(snapshotPath: string, source: ParsedSource) {
  if (!(statSync(snapshotPath).isDirectory() && existsSync(join(snapshotPath, 'package.json')))) {
    return
  }

  const commandParts = npmCommand()
  const executable = commandParts[0]
  if (!executable) {
    throw new Error('Invalid npmCommand: empty command')
  }
  const npmArgs = commandParts.slice(1)
  console.log(`Installing dependencies in ${snapshotPath}...`)
  run(executable, [...npmArgs, 'install', '--omit=dev', '--ignore-scripts'], snapshotPath)

  if (source.kind === 'npm' || source.kind === 'git') {
    await runPackagePostinstallIfAllowed(snapshotPath, executable, npmArgs)
  }
}

async function runPackagePostinstallIfAllowed(
  snapshotPath: string,
  executable: string,
  npmArgs: string[],
) {
  const postinstallScript = readPackagePostinstallScript(snapshotPath)
  if (!postinstallScript) {
    return
  }

  console.log(`Package postinstall script found: ${postinstallScript}`)
  if (!(await confirm('Run package postinstall script?'))) {
    console.log('Skipped package postinstall script.')
    return
  }

  run(
    executable,
    [...npmArgs, 'run', 'postinstall', '--if-present', '--ignore-scripts'],
    snapshotPath,
  )
}

function readPackagePostinstallScript(snapshotPath: string) {
  const packageJsonPath = join(snapshotPath, 'package.json')
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
    scripts?: { postinstall?: unknown }
  }
  const postinstallScript = packageJson.scripts?.postinstall
  if (typeof postinstallScript !== 'string' || postinstallScript.trim().length === 0) {
    return undefined
  }
  return postinstallScript
}

function upsertSettingsEntry(scope: Scope, snapshotPath: string, identity: string) {
  const settings = readSettings(scope)
  const packages = settings.packages ?? []
  const localSource = displayLocalSource(scope, snapshotPath)
  let replaced = false

  settings.packages = packages.map(entry => {
    const source = entrySource(entry)
    const existingManifest = readManifest(resolveLocalSource(source, getSettingsBaseDir(scope)))
    if (existingManifest?.identity !== identity) {
      return entry
    }

    replaced = true
    if (typeof entry === 'string') {
      return localSource
    }
    return { ...entry, source: localSource }
  })

  if (!replaced) {
    settings.packages = [...settings.packages, localSource]
  }

  writeSettings(scope, settings)
}

function replaceSettingsSource(scope: Scope, currentSource: string, nextSnapshotPath: string) {
  const settings = readSettings(scope)
  const packages = settings.packages ?? []
  const nextSource = displayLocalSource(scope, nextSnapshotPath)
  let replaced = false
  settings.packages = packages.map(entry => {
    const source = entrySource(entry)
    if (source !== currentSource) {
      return entry
    }
    replaced = true
    if (typeof entry === 'string') {
      return nextSource
    }
    return { ...entry, source: nextSource }
  })
  if (!replaced) {
    throw new Error(`Settings entry disappeared: ${currentSource}`)
  }
  writeSettings(scope, settings)
}

function findConfiguredEntries(): ConfiguredEntry[] {
  return ['project', 'global'].flatMap(scope => {
    const typedScope = scope as Scope
    const settings = readSettings(typedScope)
    return (settings.packages ?? []).map(entry => ({
      scope: typedScope,
      entry,
      source: entrySource(entry),
    }))
  })
}

function findMigratableEntries() {
  return findConfiguredEntries().filter(entry => {
    const parsed = parseSource(entry.source)
    if (parsed.kind === 'local') {
      return false
    }
    if (parsed.kind === 'npm' && isPiAiPackage(parsed.name)) {
      return false
    }
    return true
  })
}

function findManagedEntries(): ManagedEntry[] {
  return ['project', 'global'].flatMap(scope => findManagedEntriesInScope(scope as Scope))
}

function findManagedEntriesInScope(scope: Scope): ManagedEntry[] {
  const settingsPath = getSettingsPath(scope)
  const baseDir = getSettingsBaseDir(scope)
  const settings = readSettings(scope)
  const packages = settings.packages ?? []
  const managed: ManagedEntry[] = []

  for (const entry of packages) {
    const source = entrySource(entry)
    const snapshotPath = resolveLocalSource(source, baseDir)
    const manifest = readManifest(snapshotPath)
    if (!manifest) {
      continue
    }
    managed.push({ scope, entry, source, settingsPath, baseDir, snapshotPath, manifest })
  }

  return managed
}

function readManifest(snapshotPath: string): Manifest | undefined {
  const stat = statSyncIfExists(snapshotPath)
  const manifestPaths = stat?.isDirectory()
    ? [join(snapshotPath, '.pi-audit.json'), join(snapshotPath, '.pi-audit-install.json')]
    : [`${snapshotPath}.pi-audit.json`, `${snapshotPath}.pi-audit-install.json`]
  const manifestPath = manifestPaths.find(path => existsSync(path))
  if (!manifestPath) {
    return undefined
  }
  return JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest
}

function hasAvailableUpdate(entry: ManagedEntry, parsed: UpdatableSource) {
  if (parsed.kind === 'npm') {
    const installedVersion = entry.manifest.version ?? readNpmPackageVersion(entry.snapshotPath)
    if (!installedVersion) {
      return true
    }
    return getLatestNpmVersion(parsed.name) !== installedVersion
  }

  const installedHead = entry.manifest.gitHead
  if (!installedHead) {
    return true
  }
  return getRemoteGitHead(parsed) !== installedHead
}

function readNpmPackageVersion(packagePath: string) {
  const packageJsonPath = join(packagePath, 'package.json')
  if (!existsSync(packageJsonPath)) {
    return undefined
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: string }
  return packageJson.version
}

function getLatestNpmVersion(packageName: string) {
  const commandParts = npmCommand()
  const executable = commandParts[0]
  if (!executable) {
    throw new Error('Invalid npmCommand: empty command')
  }
  const stdout = run(
    executable,
    [...commandParts.slice(1), 'view', packageName, 'version', '--json'],
    process.cwd(),
  )
  const raw = stdout.trim()
  if (!raw) {
    throw new Error(`Empty npm view response for ${packageName}`)
  }
  const version = JSON.parse(raw) as unknown
  if (typeof version !== 'string') {
    throw new Error(`Invalid npm view response for ${packageName}`)
  }
  return version
}

function getRemoteGitHead(source: Extract<ParsedSource, { kind: 'git' }>) {
  const stdout = run('git', ['ls-remote', source.repo, 'HEAD'], process.cwd(), {
    GIT_TERMINAL_PROMPT: '0',
  })
  const match = stdout.match(/^([0-9a-f]{40})\s+HEAD$/m)
  if (!match?.[1]) {
    throw new Error(`Failed to determine remote HEAD for ${source.source}`)
  }
  return match[1]
}

function parseSource(source: string): ParsedSource {
  if (source.startsWith('npm:')) {
    const spec = source.slice('npm:'.length).trim()
    const parsed = parseNpmSpec(spec)
    return { kind: 'npm', source, spec, name: parsed.name, pinned: Boolean(parsed.version) }
  }

  const git = parseGitSource(source)
  if (git) {
    return { kind: 'git', source, ...git, pinned: Boolean(git.ref) }
  }

  return { kind: 'local', source, path: source, pinned: false }
}

function parseNpmSpec(spec: string) {
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/)
  if (!match) {
    return { name: spec, version: undefined }
  }
  return { name: match[1] ?? spec, version: match[2] }
}

function parseGitSource(
  source: string,
): { repo: string; host: string; path: string; ref?: string } | undefined {
  const trimmed = source.trim()
  const hasGitPrefix = trimmed.startsWith('git:')
  const raw = hasGitPrefix ? trimmed.slice(4).trim() : trimmed
  if (!(hasGitPrefix || /^(https?|ssh|git):\/\//i.test(raw))) {
    return undefined
  }

  const { repo, ref } = splitGitRef(raw)
  const normalizedRepo = normalizeGitRepo(repo, hasGitPrefix)
  const hostAndPath = gitHostAndPath(normalizedRepo)
  if (!hostAndPath) {
    return undefined
  }
  return { repo: normalizedRepo, host: hostAndPath.host, path: hostAndPath.path, ref }
}

function splitGitRef(value: string) {
  const scpLike = value.match(/^git@([^:]+):(.+)$/)
  if (scpLike) {
    const path = scpLike[2] ?? ''
    const index = path.indexOf('@')
    if (index < 0) {
      return { repo: value, ref: undefined }
    }
    return {
      repo: `git@${scpLike[1]}:${path.slice(0, index)}`,
      ref: path.slice(index + 1) || undefined,
    }
  }

  if (value.includes('://')) {
    const parsed = new URL(value)
    const path = parsed.pathname.replace(/^\/+/, '')
    const index = path.indexOf('@')
    if (index < 0) {
      return { repo: value, ref: undefined }
    }
    parsed.pathname = `/${path.slice(0, index)}`
    return { repo: parsed.toString().replace(/\/$/, ''), ref: path.slice(index + 1) || undefined }
  }

  const slash = value.indexOf('/')
  if (slash < 0) {
    return { repo: value, ref: undefined }
  }
  const host = value.slice(0, slash)
  const path = value.slice(slash + 1)
  const index = path.indexOf('@')
  if (index < 0) {
    return { repo: value, ref: undefined }
  }
  return { repo: `${host}/${path.slice(0, index)}`, ref: path.slice(index + 1) || undefined }
}

function normalizeGitRepo(repo: string, hasGitPrefix: boolean) {
  if (/^(https?|ssh|git):\/\//i.test(repo) || repo.startsWith('git@')) {
    return repo
  }
  if (hasGitPrefix) {
    return `https://${repo}`
  }
  return repo
}

function gitHostAndPath(repo: string) {
  const scpLike = repo.match(/^git@([^:]+):(.+)$/)
  if (scpLike) {
    return cleanGitPath(scpLike[1] ?? '', scpLike[2] ?? '')
  }
  if (/^(https?|ssh|git):\/\//i.test(repo)) {
    const parsed = new URL(repo)
    return cleanGitPath(parsed.hostname, parsed.pathname.replace(/^\/+/, ''))
  }
  return undefined
}

function cleanGitPath(host: string, rawPath: string) {
  const path = rawPath.replace(/\.git$/, '').replace(/^\/+/, '')
  if (!host || path.split('/').length < 2) {
    return undefined
  }
  return { host, path }
}

function identityForSource(source: ParsedSource) {
  if (source.kind === 'npm') {
    return `npm:${source.name}`
  }
  if (source.kind === 'git') {
    return `git:${source.host}/${source.path}`
  }
  return `local:${resolveLocalSource(source.path, process.cwd())}`
}

function matchesManagedEntry(inputValue: string, entry: ManagedEntry) {
  if (matchesPackage(inputValue, entry.manifest)) {
    return true
  }
  if (inputValue === entry.source) {
    return true
  }
  return resolveLocalSource(inputValue, entry.baseDir) === resolve(entry.snapshotPath)
}

function matchesPackage(inputValue: string, manifest: Manifest) {
  const parsed = parseSource(inputValue)
  const inputIdentity = identityForSource(parsed)
  if (inputIdentity === manifest.identity) {
    return true
  }
  if (manifest.identity.startsWith('npm:') && inputValue === manifest.identity.slice(4)) {
    return true
  }
  if (manifest.identity.startsWith('git:')) {
    const shorthand = manifest.identity.slice(4)
    return inputValue === shorthand || inputValue === shorthand.split('/').slice(1).join('/')
  }
  return false
}

function isPiAiPackage(packageName: string) {
  return (
    packageName === 'pi-ai' ||
    packageName === '@earendil-works/pi-ai' ||
    packageName.endsWith('/pi-ai')
  )
}

function removeOriginalInstall(scope: Scope, source: Exclude<ParsedSource, { kind: 'local' }>) {
  if (source.kind === 'npm') {
    const commandParts = npmCommand()
    const executable = commandParts[0]
    if (!executable) {
      throw new Error('Invalid npmCommand: empty command')
    }
    if (scope === 'global') {
      run(executable, [...commandParts.slice(1), 'uninstall', '-g', source.name], process.cwd())
      return
    }
    const installRoot = join(process.cwd(), '.pi', 'npm')
    if (existsSync(installRoot)) {
      run(
        executable,
        [...commandParts.slice(1), 'uninstall', source.name, '--prefix', installRoot],
        process.cwd(),
      )
    }
    return
  }

  const installRoot =
    scope === 'project' ? join(process.cwd(), '.pi', 'git') : join(getAgentDir(), 'git')
  const target = join(installRoot, source.host, source.path)
  if (!isInside(target, installRoot)) {
    throw new Error(`Refusing to remove path outside git install root: ${target}`)
  }
  rmSync(target, { recursive: true, force: true })
}

function readSettings(scope: Scope): Settings {
  const path = getSettingsPath(scope)
  if (!existsSync(path)) {
    return {}
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as Settings
}

function writeSettings(scope: Scope, settings: Settings) {
  const path = getSettingsPath(scope)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
}

function npmCommand() {
  const project = readSettings('project').npmCommand
  if (project && project.length > 0) {
    return project
  }
  const global = readSettings('global').npmCommand
  if (global && global.length > 0) {
    return global
  }
  return ['npm']
}

function getSettingsPath(scope: Scope) {
  return scope === 'project'
    ? join(process.cwd(), '.pi', 'settings.json')
    : join(getAgentDir(), 'settings.json')
}

function getSettingsBaseDir(scope: Scope) {
  return scope === 'project' ? join(process.cwd(), '.pi') : getAgentDir()
}

function getSnapshotPath(scope: Scope, source: ParsedSource) {
  return join(getStoreRoot(scope), packageStorePath(source))
}

function getStoreRoot(scope: Scope) {
  return join(getSettingsBaseDir(scope), 'audited-packages')
}

function getAgentDir() {
  const envDir = process.env.PI_CODING_AGENT_DIR
  if (envDir) {
    return expandHome(envDir)
  }
  return join(homedir(), '.pi', 'agent')
}

function displayLocalSource(scope: Scope, snapshotPath: string) {
  const rel = relative(getSettingsBaseDir(scope), snapshotPath)
  return rel || '.'
}

function isInside(path: string, parent: string) {
  const rel = relative(resolve(parent), resolve(path))
  return rel === '' || !(rel.startsWith('..') || isAbsolute(rel))
}

function resolveLocalSource(source: string, baseDir: string) {
  const expanded = expandHome(source.trim())
  if (isAbsolute(expanded)) {
    return expanded
  }
  return resolve(baseDir, expanded)
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

function entrySource(entry: PackageEntry) {
  return typeof entry === 'string' ? entry : entry.source
}

function packageStorePath(source: ParsedSource) {
  if (source.kind === 'npm') {
    return join('npm', ...source.name.split('/'))
  }
  if (source.kind === 'git') {
    return join('git', source.host, ...source.path.split('/'))
  }
  return join('local', safePathSegment(basename(source.path)))
}

function safePathSegment(value: string) {
  const safe = value.replace(/[^a-zA-Z0-9._@-]+/g, '-').replace(/^-+|-+$/g, '')
  return safe || 'package'
}

function printAudit(source: string, audit: AuditResult) {
  console.log(`${source} → ${audit.recommendation} — ${audit.report}`)
}

async function confirmAuditDecision(
  question: string,
  source: string,
  fetched: FetchedSource,
  audit: AuditResult,
) {
  while (true) {
    const decision = await promptAuditDecision(question)
    if (decision === 'yes') {
      return true
    }
    if (decision === 'no') {
      return false
    }
    askPiAboutAudit(source, fetched.auditPath, audit)
  }
}

async function promptAuditDecision(question: string): Promise<AuditDecision> {
  const rl = createInterface({ input, output })
  const answer = (await rl.question(`${question} [y]es/[n]o/[a]sk `)).trim().toLowerCase()
  rl.close()

  if (answer === 'y' || answer === 'yes') {
    return 'yes'
  }
  if (answer === '' || answer === 'n' || answer === 'no') {
    return 'no'
  }
  if (answer === 'a' || answer === 'ask') {
    return 'ask'
  }

  console.log('Enter yes, no, or ask.')
  return promptAuditDecision(question)
}

function askPiAboutAudit(source: string, auditPath: string, audit: AuditResult) {
  const systemPrompt = `You are answering follow-up questions about a Pi package security audit.

Source: ${source}
Path: ${auditPath}
Audit recommendation: ${audit.recommendation}
Audit report: ${audit.report}

Inspect the package when needed. Use only read/search/list tools. Do not execute or modify package code. Answer the user's questions about the package and audit.`

  const result = crossSpawn.sync(
    'pi',
    [
      '--provider',
      'openai-codex',
      '--model',
      'gpt-5.6-sol',
      '--thinking',
      'medium',
      '--no-session',
      '--no-context-files',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--tools',
      'read,grep,find,ls',
      '--system-prompt',
      systemPrompt,
    ],
    { cwd: process.cwd(), stdio: 'inherit' },
  )

  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`Pi question session failed with status ${result.status}`)
  }
}

async function confirm(question: string) {
  const rl = createInterface({ input, output })
  const answer = await rl.question(`${question} [y/N] `)
  rl.close()
  return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function run(commandName: string, commandArgs: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  const result = crossSpawn.sync(commandName, commandArgs, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(
      `${commandName} ${commandArgs.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    )
  }
  return result.stdout
}

function shouldCopyPath(path: string) {
  return !path.split(/[\\/]/).includes('.git')
}

function statSyncIfExists(path: string) {
  if (!existsSync(path)) {
    return undefined
  }
  return statSync(path)
}
