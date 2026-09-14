import extension from './extensions/extension.ts'

export { renderSubagentWidget } from './extensions/display.ts'
export { startJob } from './extensions/execute-subagents.ts'
export { JobRegistry } from './extensions/jobs.ts'
export type {
  ForkOverride,
  SubagentRequest,
  SubagentResultDetails,
  ThinkingLevel,
} from './extensions/types.ts'

export default extension
