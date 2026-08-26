import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

const closeKeys = new Set(["\x1b", "\x03", "\r", "q"]);

export async function showReadOnlyText(
  ctx: ExtensionCommandContext,
  title: string,
  text: string,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, _theme, _keybindings, done) => {
      const lines = text.split("\n");
      const contentWidth = lines.reduce((maximum, line) => Math.max(maximum, visibleWidth(line)), 0);
      let offset = 0;
      let columnOffset = 0;
      let innerWidth = 8;
      const viewHeight = () => Math.max(4, Math.floor((process.stdout.rows ?? 24) * 0.8) - 7);
      const clamp = (value: number) => Math.max(0, Math.min(value, Math.max(0, lines.length - viewHeight())));
      const clampColumn = (value: number) => Math.max(0, Math.min(value, Math.max(0, contentWidth - innerWidth)));

      return {
        render(width: number): string[] {
          innerWidth = Math.max(8, width - 2);
          const height = viewHeight();
          offset = clamp(offset);
          columnOffset = clampColumn(columnOffset);
          const visible = lines
            .slice(offset, offset + height)
            .map((line) => sliceByColumn(line, columnOffset, innerWidth, true));
          while (visible.length < Math.min(height, lines.length)) visible.push("");
          const rule = `\x1b[2m${"─".repeat(innerWidth)}\x1b[0m`;
          const positions: string[] = [];
          if (lines.length > height) {
            positions.push(`lines ${offset + 1}-${Math.min(offset + height, lines.length)} of ${lines.length}`);
          }
          if (contentWidth > innerWidth) {
            positions.push(
              `columns ${columnOffset + 1}-${Math.min(columnOffset + innerWidth, contentWidth)} of ${contentWidth}`,
            );
          }
          const position = sliceByColumn(positions.join(" · "), 0, innerWidth, true);
          const controls = sliceByColumn(
            "↑/↓ lines · ←/→ columns · shift+arrows page · esc/enter/q close",
            0,
            innerWidth,
            true,
          );
          return [
            `\x1b[1;36m${title}\x1b[0m`,
            rule,
            ...visible,
            rule,
            `\x1b[2m${position}\x1b[0m`,
            `\x1b[2m${controls}\x1b[0m`,
          ];
        },
        handleInput(data: string): void {
          if (closeKeys.has(data)) {
            done();
            return;
          }
          switch (data) {
            case "\x1b[A":
            case "k":
              offset = clamp(offset - 1);
              break;
            case "\x1b[B":
            case "j":
              offset = clamp(offset + 1);
              break;
            case "\x1b[5~":
              offset = clamp(offset - viewHeight());
              break;
            case "\x1b[6~":
            case " ":
              offset = clamp(offset + viewHeight());
              break;
            case "\x1b[D":
            case "h":
              columnOffset = clampColumn(columnOffset - 1);
              break;
            case "\x1b[C":
            case "l":
              columnOffset = clampColumn(columnOffset + 1);
              break;
            case "\x1b[1;2D":
              columnOffset = clampColumn(columnOffset - innerWidth);
              break;
            case "\x1b[1;2C":
              columnOffset = clampColumn(columnOffset + innerWidth);
              break;
            case "\x1b[H":
            case "\x1b[1~":
            case "g":
              offset = clamp(0);
              break;
            case "\x1b[F":
            case "\x1b[4~":
            case "G":
              offset = clamp(lines.length);
              break;
          }
          tui.requestRender();
        },
        invalidate() {},
      };
    },
    { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%" } },
  );
}
