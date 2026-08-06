import { CustomEditor, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { parseKey } from '@earendil-works/pi-tui'

class ShiftEscapeEditor extends CustomEditor {
  override handleInput(data: string): void {
    if (parseKey(data) === 'shift+escape') {
      this.onEscape?.()
      return
    }

    super.handleInput(data)
  }
}

export default function shiftEscapeExtension(pi: ExtensionAPI): void {
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return

    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) => new ShiftEscapeEditor(tui, theme, keybindings),
    )
  })
}
