const fs = require("node:fs");
const path = require("node:path");

try {
  const profile = process.argv[2];
  const home = path.join(profile, "home");
  const agent = path.join(home, ".pi", "agent");
  const regularJson = (target) => {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) process.exit(1);
    const value = JSON.parse(fs.readFileSync(target, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) process.exit(1);
    return value;
  };
  const manifest = regularJson(path.join(profile, "profile.json"));
  regularJson(path.join(agent, "settings.json"));
  if (manifest.version !== 1 || !Array.isArray(manifest.packageDirectories)) process.exit(1);
  for (const entry of manifest.packageDirectories) {
    if (typeof entry !== "string") process.exit(1);
    const target = path.resolve(home, entry);
    if ((target !== home && !target.startsWith(home + path.sep)) || !fs.statSync(target).isDirectory()) process.exit(1);
  }
} catch {
  process.exit(1);
}
