import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { it } from 'node:test'

const binDir = join(import.meta.dirname, 'bin')

function inContainer(script: string) {
  const result = spawnSync(
    'docker',
    ['run', '--rm', '-v', `${binDir}:/guard:ro`, 'bash:3.2', 'bash', '-c', script],
    { encoding: 'utf8' },
  )
  assert.equal(result.error, undefined, 'docker is required for this test')
  return result
}

const setup =
  'ln -s /usr/local/bin/bash /bin/bash; mkdir -p /work; touch /work/keep "$HOME/precious"; cd /work;'
const probe =
  'for p in /etc/passwd /usr/local/bin/bash /work/keep "$HOME/precious"; do [ -e "$p" ] && echo "$p present" || echo "$p gone"; done'

it('control: without the guard, rm -rf "$UNSET"/* destroys the container filesystem', () => {
  const result = inContainer(`${setup} rm -rf "$UNSET"/* 2>/dev/null; echo "exit=$?"; ${probe}`)
  assert.match(result.stdout, /\/etc\/passwd gone/)
  assert.match(result.stdout, /\/work\/keep gone/)
})

it('with the guard, rm -rf "$UNSET"/* is refused on real bash 3.2 before /bin/rm runs', () => {
  const result = inContainer(
    `${setup} export PI_RM_ALLOW=/work:/tmp PATH=/guard:$PATH; rm -rf "$UNSET"/*; echo "exit=$?"; ${probe}`,
  )
  assert.match(result.stderr, /pi-rm: blocked deletion outside the allowed directories/)
  assert.match(result.stdout, /exit=3/)
  assert.match(result.stdout, /\/etc\/passwd present/)
  assert.match(result.stdout, /\/usr\/local\/bin\/bash present/)
  assert.match(result.stdout, /\/work\/keep present/)
})

it('with the guard, rm -rf "$HOME" and cd $UNSET && rm -rf * are refused on real bash 3.2', () => {
  const result = inContainer(
    `${setup} export PI_RM_ALLOW=/work:/tmp PATH=/guard:$PATH; rm -rf "$HOME"; echo "exit=$?"; cd $UNSET && rm -rf *; echo "exit=$?"; ${probe}`,
  )
  assert.match(result.stdout, /exit=3\nexit=3/)
  assert.match(result.stdout, /\/etc\/passwd present/)
  assert.match(result.stdout, /\/work\/keep present/)
  assert.match(result.stdout, /\/root\/precious present/)
})
