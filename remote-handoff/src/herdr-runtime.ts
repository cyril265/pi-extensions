import { shellQuote, ssh } from "./remote.js";

const requiredRemoteCommands = ["bash", "git", "node", "npm", "tar", "flock", "ssh", "pkill"];

const ensureHerdrScript = String.raw`
if [[ -n $workspace ]]; then
  if test -e "$HOME/.pi-remote-handoff/workspaces/$workspace"; then
    printf 'occupied\n'
  else
    printf 'available\n'
  fi
fi
set -euo pipefail
umask 077
for command in ${requiredRemoteCommands.join(" ")}; do
  if ! command -v "$command" >/dev/null; then
    printf 'Missing remote command: %s\n' "$command" >&2
    exit 1
  fi
done
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 19)) process.exit(1)' || {
  printf 'Remote Node.js 22.19.0 or newer is required; found %s.\n' "$(node -p 'process.versions.node')" >&2
  exit 1
}

managed="$HOME/.pi-remote-handoff/herdr"
find_herdr() {
  local candidate version
  for candidate in "$(command -v herdr || true)" "$HOME/.local/bin/herdr" "$managed/herdr"; do
    [[ "$candidate" == /* && -x "$candidate" ]] || continue
    version=$("$candidate" --version 2>/dev/null) || continue
    [[ "$version" =~ ^herdr\ ([0-9]+)\.([0-9]+)\.([0-9]+) ]] || continue
    if (( BASH_REMATCH[1] > 0 || BASH_REMATCH[2] > 8 || (BASH_REMATCH[2] == 8 && BASH_REMATCH[3] >= 2) )); then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

find_herdr && exit 0
mkdir -p "$managed"
exec 9>"$managed.lock"
flock -x 9
find_herdr && exit 0
curl -fsSL https://herdr.dev/install.sh | HERDR_INSTALL_DIR="$managed" sh >&2
find_herdr || {
  printf 'Herdr installation did not produce Herdr 0.8.2 or newer in %s\n' "$managed" >&2
  exit 1
}
`;

export interface RemoteHerdrRuntime {
  home: string;
  command: string;
  workspaceAvailable?: boolean;
}

export async function ensureRemoteHerdr(host: string, workspace?: string): Promise<RemoteHerdrRuntime> {
  const script = [
    `workspace=${shellQuote(workspace ?? "")}`,
    `printf '%s\\n' "$HOME"`,
    ensureHerdrScript,
  ].join("\n");
  const lines = (await ssh(host, script)).stdout.trimEnd().split("\n");
  const home = lines.shift();
  const availability = workspace ? lines.shift() : undefined;
  const command = lines.shift();
  if (!home || !command) throw new Error("The remote Herdr check returned no Herdr path.");
  if (workspace && availability !== "available" && availability !== "occupied") {
    throw new Error("The remote workspace check returned an invalid response.");
  }
  return {
    home,
    command,
    ...(workspace ? { workspaceAvailable: availability === "available" } : {}),
  };
}
