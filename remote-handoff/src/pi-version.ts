import { execFile } from "node:child_process";

export function getExecutingPiVersion(command = process.argv[1]): Promise<string> {
  if (!command) throw new Error("Cannot identify the executing Pi command.");
  return new Promise((resolvePromise, reject) => {
    execFile(command, ["--version"], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Cannot read the executing Pi version: ${stderr || stdout}`.trim()));
        return;
      }
      const version = stdout.trim();
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
        reject(new Error(`Executing Pi returned an invalid version: ${JSON.stringify(version)}`));
        return;
      }
      resolvePromise(version);
    });
  });
}
