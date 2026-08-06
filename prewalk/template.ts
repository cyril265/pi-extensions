export const TEMPLATE_MESSAGE_TYPE = 'prewalk-template'
export const RESULT_MESSAGE_TYPE = 'prewalk-executor-result'
export const NUDGE_MESSAGE_TYPE = 'prewalk-nudge'

export function buildNudge(): string {
  return 'First edit landed — call dispatch_executor now, with no accompanying commentary, unless the remaining work is trivial enough to finish yourself.'
}

export function buildTemplate(task: string, hasTodoTool: boolean): string {
  const taskSection = task
    ? `Task:\n${task}`
    : 'Task: as described in the conversation above. If no task has been given yet, ask for it now and follow this workflow once it arrives.'
  const captureLine = hasTodoTool
    ? 'Then capture the plan with the todo tool: 5-9 items, each with its own validation step. The todo list steers the continuation after you exit; it serves the task, never the reverse.'
    : 'Then condense it into a final numbered checklist: 5-9 items, each with its own validation step — this is the working list.'

  return `# Prewalk workflow

${taskSection}

You are the planner. After your first edit, the work continues from your plan in this same working tree, unattended. The continuation sees the full session except this message and the dispatch call — so write all prose in first person as your own self-contained working plan, and never reference the dispatch, any handoff, or this workflow in anything you write. Work as follows:

1. If the requirements are ambiguous, ask the user now — the continuation runs unattended and cannot ask anyone.
2. Explore until you can commit to an approach — your value here is a confident opening, not exhaustive recon.
3. Write the complete implementation plan in your reply:
   - every remaining step in execution order, with the exact files, symbols, commands, and checks involved
   - known risks and edge cases, and the verification (commands, tests) that proves each step landed
   - never plan to modify tests or verification assets to make checks pass
   - re-read the plan against the project's AGENTS.md architecture rules before committing to it — a design flaw baked into the plan is executed faithfully and costs a rework pass
   ${captureLine}
4. Make the FIRST concrete edit yourself — the most decision-heavy one, so the continuation has a precedent to follow.
5. Immediately after that first edit, call dispatch_executor with no accompanying commentary. Usually without instructions — your written plan IS the instruction. Pass instructions only for what the plan does not already say: discoveries made during the first edit, scope corrections, or rework directions on a re-dispatch. Never restate the plan. Do not implement past the first edit yourself.
   Exception: if the remaining work is trivial (a handful of mechanical edits), skip the dispatch and finish it yourself — the handoff would cost more than it saves.
6. You stay responsible for the result. When the continuation's report returns, verify its work against your plan before declaring the task done.`
}

export function buildExecutorPrompt(instructions: string | undefined): string {
  const reportContract =
    'When done, end your final message with a report: every changed file with a one-line reason, and per checklist item the exact command you ran and its result. Unproven claims will be re-run.'
  if (!instructions) return `Continue with the todo list.\n\n${reportContract}`
  return `Continue with the todo list. Also:

${instructions}

${reportContract}`
}

export function buildVerifyMessage(reportText: string, executorFailed: boolean): string {
  return `Continuation finished${executorFailed ? ' WITH ERRORS' : ''}.

${reportText}

Verify the result. Your context predates these edits — judge from the diff and the report's evidence, never from earlier reads. Accept validation steps the report proves ran and passed; re-run only the unproven ones.

Fix only trivial issues directly (a couple of lines in one or two files). Anything touching multiple files or call sites: re-dispatch with the sessionKey above (never without it — without the key the work restarts from your verification commentary instead of the existing work session).`
}
