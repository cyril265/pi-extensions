import { errorMessage, herdr, inspectTab, logged, settleTab } from '../settle.ts'

function contextTabId(): string | undefined {
  try {
    const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}') as { tab_id?: string }
    if (context.tab_id) return context.tab_id
  } catch {}
  return process.env.HERDR_TAB_ID
}

async function notify(title: string, body: string): Promise<void> {
  await herdr(['notification', 'show', title, '--body', body]).catch(() => {})
}

await logged({ op: 'settle-action' }, async entry => {
  const tabId = contextTabId()
  if (!tabId) {
    entry.outcome = 'failed'
    entry.error = 'No tab to settle'
    console.error(entry.error)
    process.exitCode = 1
    return
  }
  entry.tabId = tabId
  try {
    const inspection = await inspectTab(tabId, { strict: false })
    entry.cwd = inspection.cwd
    if (inspection.blockers.length > 0) {
      entry.outcome = 'skipped'
      entry.blockers = inspection.blockers
      await notify(`Not settled: ${inspection.tab.label}`, inspection.blockers.join('; '))
      console.error(inspection.blockers.join('\n'))
      process.exitCode = 2
      return
    }
    await settleTab({
      tab: inspection.tab,
      cwd: inspection.cwd,
      sessions: inspection.sessions,
      reason: 'manual',
    })
  } catch (error) {
    entry.outcome = 'failed'
    entry.error = errorMessage(error)
    await notify('Settle failed', entry.error)
    console.error(entry.error)
    process.exitCode = 1
  }
})
