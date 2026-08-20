import extension from './extensions/extension.ts'

export { renderLiveCompact } from './extensions/display.ts'
export { startJob } from './extensions/execute-subagents.ts'
export type {
  ForkOverride,
  SubagentRequest,
  SubagentResultDetails,
  ThinkingLevel,
} from './extensions/types.ts'

export default extension
