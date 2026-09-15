import crossSpawn from 'cross-spawn'
import { readSettings } from './settings.ts'

export function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  const result = crossSpawn.sync(command, args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    )
  }
  return result.stdout
}

export function npm(args: string[], cwd: string) {
  const [executable, ...prefix] = npmCommand()
  return run(executable, [...prefix, ...args], cwd)
}

function npmCommand(): [string, ...string[]] {
  for (const scope of ['project', 'global'] as const) {
    const configured = readSettings(scope).npmCommand
    if (configured?.length) {
      return configured as [string, ...string[]]
    }
  }
  return ['npm']
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
