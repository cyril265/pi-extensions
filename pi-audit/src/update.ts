import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import crossSpawn from 'cross-spawn'
import { auditPackage, formatAudit, type AuditResult, type PreviousAudit } from './audit.ts'
import { errorMessage } from './exec.ts'
import { confirmAuditDecision } from './prompt.ts'
import { getAgentDir } from './settings.ts'
import {
  copyToStore,
  displayLocalSource,
  installSnapshotDependencies,
  replaceSettingsSource,
  type ManagedEntry,
} from './store.ts'
import {
  copyTree,
  fetchRemote,
  getLatestNpmVersion,
  getRemoteGitHead,
  parseSource,
  type FetchedRemote,
  type RemoteSource,
} from './sources.ts'

type Candidate = { entry: ManagedEntry; parsed: RemoteSource }
type AuditedUpdate = Candidate & {
  fetched: FetchedRemote
  previous: PreviousAudit
  audit: AuditResult
}
type Outcome =
  | ({ status: 'audited' } & AuditedUpdate)
  | {
      status: 'failed'
      entry: ManagedEntry
      stage: 'check' | 'fetch' | 'audit'
      error: string
      fetched?: FetchedRemote
    }

export async function updateOne(entry: ManagedEntry) {
  const parsed = parseSource(entry.manifest.source)
  if (parsed.kind === 'local' || parsed.pinned) {
    console.log(`${entry.manifest.source} pinned/local, skipped.`)
    return
  }
  if (!hasAvailableUpdate(entry, parsed)) {
    console.log(`${entry.manifest.source} is current.`)
    return
  }

  const update = auditCandidate({ entry, parsed })
  console.log(`${entry.manifest.source} → ${formatAudit(update.audit)}`)
  if (await approve(update)) {
    await apply(update)
  }
}

export async function updateAll(entries: ManagedEntry[]) {
  const outcomes: Outcome[] = []
  let skipped = 0
  let current = 0
  for (const entry of entries) {
    try {
      const parsed = parseSource(entry.manifest.source)
      if (parsed.kind === 'local' || parsed.pinned) {
        skipped += 1
      } else if (hasAvailableUpdate(entry, parsed)) {
        outcomes.push(auditOutcome({ entry, parsed }))
      } else {
        current += 1
      }
    } catch (error) {
      outcomes.push({ status: 'failed', entry, stage: 'check', error: errorMessage(error) })
    }
  }

  const audited = outcomes.filter(outcome => outcome.status === 'audited')
  const failed = outcomes.filter(outcome => outcome.status === 'failed')
  console.log(
    `${entries.length} managed package(s), ${audited.length} update(s) audited, ${current} current, ${skipped} skipped, ${failed.length} failed.`,
  )
  if (outcomes.length === 0) {
    return
  }

  const reportPath = saveReport(outcomes)
  console.log(`Audit report saved: ${reportPath}`)
  for (const [index, outcome] of outcomes.entries()) {
    const prefix = `${index + 1}. [${outcome.entry.scope}] ${outcome.entry.manifest.identity}`
    if (outcome.status === 'audited') {
      console.log(`${prefix}: ${currentRevision(outcome.entry)} → ${outcome.fetched.revision.pinnedSource}; ${formatAudit(outcome.audit)}`)
    } else {
      console.log(`${prefix}: failed during ${outcome.stage} — ${outcome.error}`)
    }
  }

  const approved: AuditedUpdate[] = []
  for (const [index, update] of audited.entries()) {
    console.log(`\n[${index + 1}/${audited.length}] ${update.entry.manifest.identity}`)
    console.log(`Current: ${currentRevision(update.entry)}`)
    console.log(`Candidate: ${update.fetched.revision.pinnedSource}`)
    console.log(`Audit: ${formatAudit(update.audit)}`)
    if (await approve(update)) {
      approved.push(update)
    }
  }
  for (const update of approved) {
    await apply(update)
  }

  if (failed.length > 0) {
    console.error(`${failed.length} update check/audit(s) failed. See ${reportPath}.`)
    process.exitCode = 1
  }
}

function hasAvailableUpdate(entry: ManagedEntry, parsed: RemoteSource) {
  const { manifest } = entry
  if (parsed.kind === 'npm' && manifest.kind === 'npm') {
    return getLatestNpmVersion(parsed.name) !== manifest.version
  }
  if (parsed.kind === 'git' && manifest.kind === 'git') {
    return getRemoteGitHead(parsed) !== manifest.gitHead
  }
  throw new Error(`Manifest kind ${manifest.kind} does not match source ${parsed.source}`)
}

function auditCandidate(candidate: Candidate): AuditedUpdate {
  return auditFetched(candidate, fetchRemote(candidate.parsed))
}

function auditFetched(candidate: Candidate, fetched: FetchedRemote): AuditedUpdate {
  const previous = previousAudit(candidate.entry, fetched)
  const audit = auditPackage(candidate.entry.manifest.source, fetched.auditPath, previous)
  return { ...candidate, fetched, previous, audit }
}

function auditOutcome(candidate: Candidate): Outcome {
  const { entry } = candidate
  let fetched: FetchedRemote
  try {
    fetched = fetchRemote(candidate.parsed)
  } catch (error) {
    return { status: 'failed', entry, stage: 'fetch', error: errorMessage(error) }
  }
  try {
    return { status: 'audited', ...auditFetched(candidate, fetched) }
  } catch (error) {
    return { status: 'failed', entry, stage: 'audit', error: errorMessage(error), fetched }
  }
}

function previousAudit(entry: ManagedEntry, fetched: FetchedRemote): PreviousAudit {
  const root = dirname(fetched.auditPath)
  copyTree(entry.snapshotPath, join(root, 'installed'))
  copyTree(fetched.auditPath, join(root, 'candidate'))
  const diffPath = writeUpdateDiff(root)
  return { revision: currentRevision(entry), audit: entry.manifest.audit, diffPath }
}

export function writeUpdateDiff(root: string): string {
  const diffPath = join(root, 'changes.diff')
  const fd = openSync(diffPath, 'w')
  try {
    // Write directly to disk: large package diffs exceed spawnSync's output buffer.
    const diff = crossSpawn.sync(
      'git',
      ['diff', '--no-index', '--', 'installed', 'candidate'],
      { cwd: root, encoding: 'utf-8', stdio: ['ignore', fd, 'pipe'] },
    )
    if (diff.error) {
      throw diff.error
    }
    if (diff.status !== 0 && diff.status !== 1) {
      throw new Error(`git diff failed: ${diff.stderr?.trim() ?? `exit status ${diff.status}`}`)
    }
    return diffPath
  } finally {
    closeSync(fd)
  }
}

async function approve(update: AuditedUpdate) {
  const approved = await confirmAuditDecision(
    'Update?',
    update.entry.manifest.source,
    update.fetched.auditPath,
    update.audit,
    update.previous,
  )
  if (!approved) {
    console.log('Skipped.')
  }
  return approved
}

async function apply(update: AuditedUpdate) {
  const { entry, fetched, parsed, audit } = update
  const snapshotPath = copyToStore(entry.scope, fetched, parsed, audit)
  await installSnapshotDependencies(snapshotPath)
  replaceSettingsSource(entry.scope, entry.source, snapshotPath)
  console.log(`Updated audited snapshot: ${displayLocalSource(entry.scope, snapshotPath)}`)
}

function saveReport(outcomes: Outcome[]) {
  const runsDir = join(getAgentDir(), 'audit-runs')
  mkdirSync(runsDir, { recursive: true })
  const generatedAt = new Date().toISOString()
  const reportPath = join(runsDir, `${generatedAt.replace(/[:.]/g, '-')}.json`)
  const updates = outcomes.map(outcome => ({
    status: outcome.status,
    scope: outcome.entry.scope,
    identity: outcome.entry.manifest.identity,
    settingsPath: outcome.entry.settingsPath,
    snapshotPath: outcome.entry.snapshotPath,
    current: outcome.entry.manifest,
    candidate: outcome.fetched?.revision,
    ...(outcome.status === 'audited'
      ? { audit: outcome.audit }
      : { failure: { stage: outcome.stage, message: outcome.error } }),
  }))
  writeFileSync(reportPath, `${JSON.stringify({ generatedAt, updates }, null, 2)}\n`, 'utf-8')
  return reportPath
}

function currentRevision(entry: ManagedEntry) {
  const { manifest } = entry
  if (manifest.kind === 'npm') {
    return manifest.version
  }
  if (manifest.kind === 'git') {
    return manifest.gitHead.slice(0, 12)
  }
  return manifest.source
}
