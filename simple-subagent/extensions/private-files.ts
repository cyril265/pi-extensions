import * as fs from 'node:fs'

export function writePrivateFile(filePath: string, contents: string, flag = 'w'): void {
  fs.writeFileSync(filePath, contents, { flag, mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}
