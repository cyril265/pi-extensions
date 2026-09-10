const fs = require("node:fs");

const validCredential = (credential) => {
  if (credential === null || typeof credential !== "object" || Array.isArray(credential)) return false;
  if (credential.type === "api_key") {
    if (Object.hasOwn(credential, "key") && typeof credential.key !== "string") return false;
    if (!Object.hasOwn(credential, "env")) return true;
    return credential.env !== null
      && typeof credential.env === "object"
      && !Array.isArray(credential.env)
      && Object.values(credential.env).every((entry) => typeof entry === "string");
  }
  return credential.type === "oauth"
    && typeof credential.access === "string"
    && typeof credential.refresh === "string"
    && typeof credential.expires === "number"
    && Number.isFinite(credential.expires);
};

const validAuthentication = (authentication) => authentication !== null
  && typeof authentication === "object"
  && !Array.isArray(authentication)
  && Object.values(authentication).every(validCredential);

try {
  const target = process.argv[2];
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) process.exit(1);
  if (!validAuthentication(JSON.parse(fs.readFileSync(target, "utf8")))) process.exit(1);
} catch {
  process.exit(1);
}
