import { relative } from 'node:path'
import { summarize } from './metrics.ts'
import type { RunResult } from './types.ts'

export function pairedComparisons(results: RunResult[]) {
  const groups = new Map<string, RunResult[]>()
  for (const result of results) {
    const key = `${result.model} | ${result.scenario}`
    groups.set(key, [...(groups.get(key) ?? []), result])
  }
  const comparisons = []
  for (const [key, group] of groups) {
    const variants = [...new Set(group.map(run => run.variant))].sort()
    for (let i = 0; i < variants.length; i++) for (let j = i + 1; j < variants.length; j++) {
      const left = variants[i], right = variants[j]
      const pairs = group.filter(run => run.variant === left).flatMap(a => {
        const b = group.find(run => run.variant === right && run.seed === a.seed && run.repeat === a.repeat)
        return b ? [{ a, b }] : []
      })
      const eligible = pairs.filter(({ a, b }) => ![a.status, b.status].some(status => status === 'infrastructure-error' || status === 'interrupted'))
      const bothPassed = eligible.filter(({ a, b }) => a.status === 'passed' && b.status === 'passed')
      comparisons.push({
        key, left, right, matched: pairs.length, eligible: eligible.length, bothPassed: bothPassed.length,
        onlyLeftPassed: eligible.filter(({ a, b }) => a.status === 'passed' && b.status !== 'passed').length,
        onlyRightPassed: eligible.filter(({ a, b }) => a.status !== 'passed' && b.status === 'passed').length,
        // Raw paired differences stay inspectable; positive means right used more.
        elapsedDeltaMsRightMinusLeft: bothPassed.map(({ a, b }) => b.metrics.elapsedMs - a.metrics.elapsedMs),
        parentRequestDeltaRightMinusLeft: bothPassed.map(({ a, b }) => b.metrics.parent.requests - a.metrics.parent.requests),
        parentInputDeltaRightMinusLeft: bothPassed.map(({ a, b }) => b.metrics.parent.input - a.metrics.parent.input),
      })
    }
  }
  return comparisons
}

export function renderReport(results: RunResult[], root: string): string {
  const rows = summarize(results)
  const number = (value: number | null) => value === null ? '—' : String(Math.round(value * 10) / 10)
  return [
    '# Subagent behavior evaluation', '',
    'These results grade completed artifacts and recorded behavior, not a preferred first tool. This is a synthetic fixture suite, not a production-workload benchmark. Small samples cannot establish a winner.', '',
    'Timing and request medians below include successful trials only. Infrastructure errors are reported separately; timeouts and budget exhaustion count as failures. Read paired-comparisons.json before interpreting differences.', '',
    '| Model / case / interface | Passed / eligible | 95% success interval | Infrastructure errors | Median ms, passed | Parent requests, passed | Parent input / cached input / output, passed |',
    '|---|---:|---|---:|---:|---:|---|',
    ...rows.map(row => `| ${row.key.replaceAll('|', '/')} | ${row.passed}/${row.eligible} | ${row.successRate95?.map(value => `${Math.round(value * 100)}%`).join('–') ?? '—'} | ${row.infrastructureErrors} | ${number(row.medianElapsedMsPassed)} | ${number(row.medianParentRequestsPassed)} | ${number(row.medianParentInputPassed)} / ${number(row.medianParentCacheReadPassed)} / ${number(row.medianParentOutputPassed)} |`),
    '', '## Trials', '',
    ...results.map(result => `- [${result.scenario} / ${result.variant} / repeat ${result.repeat}](${relative(root, result.artifactDirectory).split('\\').join('/')}/result.json): **${result.status}**${result.checks.some(check => !check.pass) ? ` — ${result.checks.filter(check => !check.pass).map(check => check.name).join('; ')}` : ''}`),
    '', '## Interpretation limits', '',
    '- Input, output, cache reads/writes and provider-reported cost are recorded separately. A zero reported cost is not evidence of free execution. Failed provider requests may have incomplete usage.',
    '- Parent requests while jobs are pending and possible polling calls are diagnostics, not automatic judgments of wasted reasoning. Inspect traces.',
    '- The parent-progress case uses a controlled integration gate. Its timestamps test ordering, not realistic service latency. File-change provenance is observational, not OS-level attribution.',
    '- All children use the same model/thinking and isolated tool configuration. These runs do not test model-selection strategy, Herdr, or your installed permission/tool overrides.',
    '',
  ].join('\n')
}
