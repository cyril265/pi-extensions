import { copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { npm, run } from './exec.ts'
import { resolveLocalSource } from './settings.ts'

export type NpmSource = { kind: 'npm'; source: string; spec: string; name: string; pinned: boolean }
export type GitSource = {
  kind: 'git'
  source: string
  repo: string
  host: string
  path: string
  ref?: string
  pinned: boolean
}
export type LocalSource = { kind: 'local'; source: string; path: string; pinned: false }
export type ParsedSource = NpmSource | GitSource | LocalSource
export type RemoteSource = NpmSource | GitSource

export type Revision =
  | { kind: 'npm'; version: string; pinnedSource: string }
  | { kind: 'git'; gitHead: string; pinnedSource: string }
  | { kind: 'local' }
export type RemoteRevision = Exclude<Revision, { kind: 'local' }>
export type FetchedSource = { auditPath: string; revision: Revision }
export type FetchedRemote = { auditPath: string; revision: RemoteRevision }

export function parseSource(source: string): ParsedSource {
  if (source.startsWith('npm:')) {
    const spec = source.slice('npm:'.length).trim()
    const { name, version } = parseNpmSpec(spec)
    return { kind: 'npm', source, spec, name, pinned: Boolean(version) }
  }

  const git = parseGitSource(source)
  if (git) {
    return { kind: 'git', source, ...git, pinned: Boolean(git.ref) }
  }

  return { kind: 'local', source, path: source, pinned: false }
}

export function identityForSource(source: ParsedSource) {
  if (source.kind === 'npm') {
    return `npm:${source.name}`
  }
  if (source.kind === 'git') {
    return `git:${source.host}/${source.path}`
  }
  return `local:${resolveLocalSource(source.path, process.cwd())}`
}

export function fetchSource(source: ParsedSource): FetchedSource {
  const root = mkdtempSync(join(tmpdir(), 'pi-audit-'))
  const fetched = fetchInto(source, root)
  if (hasPackageJson(fetched.auditPath)) {
    console.log('Installing dependencies for review...')
    npm(['install', ...dependencyInstallFlags], fetched.auditPath)
  }
  return fetched
}

function fetchInto(source: ParsedSource, root: string): FetchedSource {
  if (source.kind === 'npm') {
    return fetchNpm(source, root)
  }
  if (source.kind === 'git') {
    return fetchGit(source, root)
  }
  return fetchLocal(source, root)
}

export function fetchRemote(source: RemoteSource) {
  return fetchSource(source) as FetchedRemote
}

function fetchNpm(source: NpmSource, root: string): FetchedSource {
  npm(['pack', source.spec, '--pack-destination', root, '--json'], process.cwd())
  const tarball = readdirSync(root).find(file => file.endsWith('.tgz'))
  if (!tarball) {
    throw new Error(`npm pack did not produce tarball for ${source.source}`)
  }
  run('tar', ['-xzf', join(root, tarball), '-C', root], process.cwd())
  const auditPath = join(root, 'package')
  if (!existsSync(auditPath)) {
    throw new Error(`npm tarball has no package directory: ${source.source}`)
  }
  const version = readNpmPackageVersion(auditPath)
  return {
    auditPath,
    revision: { kind: 'npm', version, pinnedSource: `npm:${source.name}@${version}` },
  }
}

function fetchGit(source: GitSource, root: string): FetchedSource {
  const auditPath = join(root, 'repo')
  run('git', ['clone', source.repo, auditPath], process.cwd(), { GIT_TERMINAL_PROMPT: '0' })
  if (source.ref) {
    run('git', ['checkout', source.ref], auditPath)
  }
  const gitHead = run('git', ['rev-parse', 'HEAD'], auditPath).trim()
  return {
    auditPath,
    revision: { kind: 'git', gitHead, pinnedSource: `git:${source.repo}@${gitHead}` },
  }
}

function fetchLocal(source: LocalSource, root: string): FetchedSource {
  const resolved = resolveLocalSource(source.path, process.cwd())
  if (!existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`)
  }
  const auditPath = join(root, basename(resolved))
  copyTree(resolved, auditPath)
  return { auditPath, revision: { kind: 'local' } }
}

export function copyTree(from: string, to: string) {
  if (statSync(from).isDirectory()) {
    cpSync(from, to, { recursive: true, dereference: false, filter: shouldCopyPath })
  } else {
    copyFileSync(from, to)
  }
}

export function hasPackageJson(path: string) {
  return statSync(path).isDirectory() && existsSync(join(path, 'package.json'))
}

// Pi aliases its peer packages (@earendil-works/*, typebox) to its bundled copies at load time.
export const dependencyInstallFlags = ['--omit=dev', '--ignore-scripts', '--legacy-peer-deps']

function shouldCopyPath(path: string) {
  const segments = path.split(/[\\/]/)
  return !segments.some(segment => ['.git', 'node_modules', '.pi-audit.json'].includes(segment))
}

export function readNpmPackageVersion(packagePath: string) {
  const packageJson = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf-8')) as {
    version?: string
  }
  if (!packageJson.version) {
    throw new Error(`package.json has no version: ${packagePath}`)
  }
  return packageJson.version
}

export function getLatestNpmVersion(packageName: string) {
  const raw = npm(['view', packageName, 'version', '--json'], process.cwd()).trim()
  const version = raw ? (JSON.parse(raw) as unknown) : undefined
  if (typeof version !== 'string') {
    throw new Error(`Invalid npm view response for ${packageName}: ${raw}`)
  }
  return version
}

export function getRemoteGitHead(source: GitSource) {
  const stdout = run('git', ['ls-remote', source.repo, 'HEAD'], process.cwd(), {
    GIT_TERMINAL_PROMPT: '0',
  })
  const match = stdout.match(/^([0-9a-f]{40})\s+HEAD$/m)
  if (!match?.[1]) {
    throw new Error(`Failed to determine remote HEAD for ${source.source}`)
  }
  return match[1]
}

function parseNpmSpec(spec: string) {
  const match = spec.match(/^((?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*)(?:@(.+))?$/)
  if (!match?.[1]) {
    throw new Error(`Invalid npm spec: ${spec}`)
  }
  return { name: match[1], version: match[2] }
}

function parseGitSource(
  source: string,
): { repo: string; host: string; path: string; ref?: string } | undefined {
  const trimmed = source.trim()
  const hasGitPrefix = trimmed.startsWith('git:')
  const raw = hasGitPrefix ? trimmed.slice(4).trim() : trimmed
  if (!(hasGitPrefix || isGitUrl(raw))) {
    return undefined
  }

  const { repo, ref } = splitGitRef(raw)
  const normalizedRepo = hasGitPrefix && !isGitUrl(repo) && !repo.startsWith('git@') ? `https://${repo}` : repo
  const hostAndPath = gitHostAndPath(normalizedRepo)
  if (!hostAndPath) {
    return undefined
  }
  return { repo: normalizedRepo, ...hostAndPath, ref }
}

function isGitUrl(value: string) {
  return /^(https?|ssh|git):\/\//i.test(value)
}

function splitGitRef(value: string) {
  const scpLike = value.match(/^git@([^:]+):(.+)$/)
  if (scpLike) {
    const [path, ref] = splitAt(scpLike[2] ?? '')
    return { repo: `git@${scpLike[1]}:${path}`, ref }
  }

  if (value.includes('://')) {
    const parsed = new URL(value)
    const [path, ref] = splitAt(parsed.pathname.replace(/^\/+/, ''))
    parsed.pathname = `/${path}`
    return { repo: parsed.toString().replace(/\/$/, ''), ref }
  }

  const slash = value.indexOf('/')
  if (slash < 0) {
    return { repo: value, ref: undefined }
  }
  const [path, ref] = splitAt(value.slice(slash + 1))
  return { repo: `${value.slice(0, slash)}/${path}`, ref }
}

function splitAt(path: string): [string, string | undefined] {
  const index = path.indexOf('@')
  if (index < 0) {
    return [path, undefined]
  }
  return [path.slice(0, index), path.slice(index + 1) || undefined]
}

function gitHostAndPath(repo: string) {
  const scpLike = repo.match(/^git@([^:]+):(.+)$/)
  if (scpLike) {
    return cleanGitPath(scpLike[1] ?? '', scpLike[2] ?? '')
  }
  if (isGitUrl(repo)) {
    const parsed = new URL(repo)
    return cleanGitPath(parsed.hostname, parsed.pathname)
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
