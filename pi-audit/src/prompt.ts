import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { askPiAboutAudit, type AuditResult, type PreviousAudit } from './audit.ts'

export async function confirm(question: string) {
  const answer = (await ask(`${question} [y/N] `)).toLowerCase()
  return answer === 'y' || answer === 'yes'
}

export async function confirmAuditDecision(
  question: string,
  source: string,
  auditPath: string,
  audit: AuditResult,
  previous?: PreviousAudit,
) {
  while (true) {
    const answer = (await ask(`${question} [y]es/[n]o/[a]sk `)).toLowerCase()
    if (answer === 'y' || answer === 'yes') {
      return true
    }
    if (answer === '' || answer === 'n' || answer === 'no') {
      return false
    }
    if (answer === 'a' || answer === 'ask') {
      askPiAboutAudit(source, auditPath, audit, previous)
    } else {
      console.log('Enter yes, no, or ask.')
    }
  }
}

async function ask(question: string) {
  const rl = createInterface({ input, output })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}
