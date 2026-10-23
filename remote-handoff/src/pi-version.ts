import { VERSION } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";

export function piInvocation(args: readonly string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && existsSync(script)) return { command: process.execPath, args: [script, ...args] };
  return { command: process.execPath, args: [...args] };
}

export function executingPiVersion(): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(VERSION)) {
    throw new Error(`Executing Pi reports an invalid version: ${JSON.stringify(VERSION)}`);
  }
  return VERSION;
}
