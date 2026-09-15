#!/usr/bin/env node

import { auditPackage, formatAudit } from './audit.ts'
import { confirmAuditDecision } from './prompt.ts'
import type { Scope } from './settings.ts'
import {
  copyToStore,
  displayLocalSource,
  findConfiguredEntries,
  findManagedEntries,
  installSnapshotDependencies,
  matchesManagedEntry,
  removeOriginalInstall,
  replaceSettingsSource,
  upsertSettingsEntry,
  type ConfiguredEntry,
} from './store.ts'
import { fetchSource, identityForSource, parseSource, type RemoteSource } from './sources.ts'
import { errorMessage } from './exec.ts'
import { updateAll, updateOne } from './update.ts'

const [command, ...args] = process.argv.slice(2)

if (!command || command === '-h' || command === '--help') {
  usage()
  process.exit(command ? 0 : 1)
}

try {
  if (command === 'install') {
    await installCommand(args)
  } else if (command === 'update' || command === 'update-all') {
    await updateCommand(args)
  } else if (command === 'migrate') {
    await migrateCommand(args)
  } else {
    usage()
    process.exit(1)
  }
} catch (error) {
  console.error(`Error: ${errorMessage(error)}`)
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
  console.log(`${source} → ${formatAudit(audit)}`)

  if (!(await confirmAuditDecision('Install?', source, fetched.auditPath, audit))) {
    console.log('Skipped.')
    return
  }

  const snapshotPath = copyToStore(scope, fetched, parsed, audit)
  await installSnapshotDependencies(snapshotPath)
  upsertSettingsEntry(scope, snapshotPath, identityForSource(parsed))
  console.log(`Installed audited snapshot: ${displayLocalSource(scope, snapshotPath)}`)
}

async function updateCommand(rawArgs: string[]) {
  if (rawArgs.length > 1 || (command === 'update-all' && rawArgs.length > 0)) {
    throw new Error('Usage: pi-audit update [package]')
  }

  const entries = findManagedEntries()
  if (rawArgs.length === 0) {
    if (entries.length === 0) {
      console.log('No managed packages found.')
      return
    }
    await updateAll(entries)
    return
  }

  const matches = entries.filter(entry => matchesManagedEntry(rawArgs[0], entry))
  if (matches.length === 0) {
    throw new Error(`No managed package found for ${rawArgs[0]}`)
  }
  for (const entry of matches) {
    await updateOne(entry)
  }
}

async function migrateCommand(rawArgs: string[]) {
  if (rawArgs.length !== 0) {
    throw new Error('Usage: pi-audit migrate')
  }

  const entries = findConfiguredEntries().flatMap(entry => {
    const parsed = parseSource(entry.source)
    return parsed.kind === 'local' ? [] : [{ ...entry, parsed }]
  })
  if (entries.length === 0) {
    console.log('No npm/git packages to migrate.')
    return
  }

  console.log(`${entries.length} package(s) to migrate.`)
  for (const entry of entries) {
    await migrateEntry(entry)
  }
}

async function migrateEntry(entry: ConfiguredEntry & { parsed: RemoteSource }) {
  const { scope, source, parsed } = entry
  const fetched = fetchSource(parsed)
  const audit = auditPackage(source, fetched.auditPath)
  console.log(`${source} → ${formatAudit(audit)}`)

  if (!(await confirmAuditDecision('Migrate?', source, fetched.auditPath, audit))) {
    console.log('Skipped.')
    return
  }

  const snapshotPath = copyToStore(scope, fetched, parsed, audit)
  await installSnapshotDependencies(snapshotPath)
  replaceSettingsSource(scope, source, snapshotPath)
  removeOriginalInstall(scope, parsed)
  console.log(`Migrated audited snapshot: ${displayLocalSource(scope, snapshotPath)}`)
}

function parseInstallArgs(rawArgs: string[]) {
  const local = rawArgs.includes('-l') || rawArgs.includes('--local')
  const positional = rawArgs.filter(arg => arg !== '-l' && arg !== '--local')
  if (positional.length !== 1) {
    throw new Error('Usage: pi-audit install <source> [-l|--local]')
  }
  return { source: positional[0], local }
}
