import extension from './extensions/extension.ts'

export { renderSubagentDetails } from './extensions/display.ts'
export { executeSubagents } from './extensions/execute-subagents.ts'
export type {
  ForkOverride,
  SubagentRequest,
  SubagentResultDetails,
  ThinkingLevel,
} from './extensions/types.ts'

export default extension
