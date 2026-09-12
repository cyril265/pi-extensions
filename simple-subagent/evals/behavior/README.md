# Behavior and interface evals

This suite compares task outcomes, coordination, recovery, and resource use. It does
not mark a run correct because the parent selected a preferred first tool.

The parent and delegated workers are real Pi/model processes. Production job execution,
session locking, automatic delivery, and cancellation run through the actual extension
code. Artifacts are checked by deterministic oracles outside the task directory, and
ordering is checked against cross-process traces. There is no model judge.

## Questions and cases

| Case | Question | Main evidence |
|---|---|---|
| `parallel-repair` | Can independent coding tasks finish without lost work? | Behavioral checks on both modules; distinct child sessions |
| `parent-progress` | Can the parent work while delegation remains pending? | Parent-owned configuration change during a pending job; controlled integration gate |
| `dependent-verification` | Does independent verification happen after implementation? | Different writer/verifier sessions, completed predecessor, real verification command and behavior |
| `large-report` | Are important findings beyond inline limits used? | Child response exceeds 2048 characters; late violation corrected and recorded |
| `quoting-and-paths` | Do literal values and awkward paths survive the interface? | Executable label checks, metacharacter sentinels, cwd containing spaces, quotes, dollar sign and Unicode |
| `session-followup` | Is reviewer context reused across a follow-up? | Two user phases; removed note; repeated child session identity and correct follow-up |
| `partial-failure` | Does a worker crash preserve successful work? | Actual one-time child termination; correct pricing and accurate failure/recovery report |
| `cancellation` | Can changed user priorities stop active work? | Follow-up after a child probe starts; cancellation accepted; job settles; actual subprocess liveness checked before harness cleanup |
| `semantic-blocker` | Is a normal exit containing a blocker treated appropriately? | No invented migration destination; original configuration preserved; blocked decision |
| `small-local-change` | Does delegation availability add unnecessary overhead? | Correct trivial edit; observed requests/tokens/child launches, with no forced routing assertion |

Task prompts are identical across variants. The output formats requested for a few
report artifacts are grading contracts, not required ways to call tools. Most cases
explicitly request delegation because they test a delegated workflow. The local-change
control does not. These are compact synthetic tasks, not a representative sample of
production software work.

## Variants

| Variant | Exposed interface |
|---|---|
| `native` | Production `runSubAgents` and `cancelSubAgents`; no Node client, and its hint is removed from the tool description |
| `client` | Production as shipped: the same tools plus the Node client reachable from bash |

`client` is the interface under test; `native` is the control. All child requests use the
specified model and thinking level, regardless of the parent's attempted overrides.
Children receive the same isolated stock tools and telemetry extension across arms, with
further delegation unavailable.

Settlement is observed from the production push message for dispatched jobs and from the
bridge's join for client runs. The evaluator never joins a job itself before it settles,
because a joiner suppresses automatic delivery.

## Running

From `simple-subagent/`, preview without any provider calls:

```bash
npm run eval:behavior
```

The default is **four trials**: `small-local-change` and `parallel-repair`, each with
`native` and `client`, once. The model remains `openai-codex/gpt-5.6-sol` and thinking
remains `medium` for parents and children. There are no cheaper-model substitutions.

Run only the case affected by a change:

```bash
npm run eval:behavior -- \
  --cases parallel-repair --variants native,client \
  --out /tmp/subagent-comparison-01 --execute
```

Use optional `--models` and `--thinking` overrides when testing a different actual
configuration. Neither is required for live runs. `--seed` controls fixture variation
and randomized arm order; it does not
seed provider sampling. Repetitions share the same fixture seed across interface arms.
Runs execute serially to avoid cross-arm contention. Keep source files unchanged
during a comparative campaign; the manifest records their initial hashes, and concurrent
edits invalidate interface comparisons. Output directories cannot be
reused accidentally. The runner stops on the first failed trial by default. `--keep-going`
permits continuing after task failures, but never bypasses campaign caps, infrastructure
errors, or usage exhaustion. Trials and provider runs are not automatically retried.

Nothing runs until `--execute` is supplied. Campaign limits are shared by every parent
and child process across all trials:

| Flag | Default | Scope |
|---|---:|---|
| `--max-runs` | 4 | Oversized live plans are rejected before launching |
| `--campaign-requests` | 60 | Atomic admission limit for model calls across the campaign |
| `--campaign-tokens` | 200000 | Reported input + output + cache reads/writes across the campaign |
| `--campaign-timeout` | 600 | Total campaign seconds |
| `--max-requests` | 30 | Additional per-trial admission limit, including children |
| `--max-tokens` | 100000 | Additional per-trial reported-token limit |
| `--timeout` | 180 | Per-trial seconds |

Each process must acquire an atomic request ticket before sending a model request.
Denied requests never leave the provider hook; the runner stops and cleans up the trial.
The last admitted request may finish. Token accounting arrives after responses, so
in-flight responses can overshoot the token threshold; the 200 ms observer stops the
campaign when it sees exhaustion. These are model-request and reported-token limits,
not a claimed conversion to subscription quota or a bill estimate. A trial starts only
if campaign budget remains. `budget.json` records consumption, why execution stopped,
and how many planned trials were left unrun. Unrun trials are not scored as successes.

`--cases all`, larger `--max-runs`, and extra repetitions are explicit opt-ins. Changing
the model, thinking level, or substituting simulated children is not a token-saving
shortcut in these live comparisons.

Retry only unsuccessful attempted trials, preserving their original model, thinking,
variant, fixture seed, and repetition:

```bash
npm run eval:behavior -- --rerun-failed /tmp/subagent-comparison-01
# Review the smaller plan, then add --execute if needed.
```

Recompute grading and reports from saved artifacts **without any model calls**:

```bash
npm run eval:behavior -- --regrade /tmp/subagent-comparison-01
```

Regrading writes a fresh report directory, reuses the saved oracle and transcripts,
and leaves original results untouched. Original timeout/budget/interruption statuses
are preserved. It is useful for scoring/report changes, not evidence that a changed
interface would reproduce the old behavior. Live fixtures are checked offline before
launch, and final reports are requested to be concise unless a case needs a full report.

The runner currently requires POSIX process groups. It uses RPC for the parent so a
pending job does not hold a single-shot `turn_end` and prevent useful parent work.
It waits for parent quiescence and registered job settlement, then terminates the whole
trial process group, including detached-from-the-shell client scripts and probes. An
arbitrary shell workflow that outlives all registered jobs is not a durable scheduler:
the normal quiescence grace may end that workflow, just as session exit can in production.
Ctrl-C requests cleanup and retains the interrupted trial.

User settings, skills, extensions and sessions are not loaded. Necessary `auth.json`
and optional `models.json` are copied to a private temporary agent directory and removed
after the trial; credentials are never included in retained evidence. Child session
logs are copied separately. OAuth refresh in this isolated copy does not update the
original credential store. Environment-based provider credentials remain available.
These evals execute model-authored code in fixture directories; they are not a security
sandbox.

## Evidence and interpretation

Each campaign retains:

- `manifest.json`: options, exact randomized plan, Node/platform, git commit and hashes
  of tracked and uncommitted source files.
- `report.md`, `summary.json`: per-model/per-case success rates and Wilson 95% intervals,
  infrastructure errors, successful-run latency and request/token summaries.
- `paired-comparisons.json`: matched fixture/repetition outcome counts and raw paired
  request, input-token and elapsed-time differences for pairs where both succeeded.
- `results.jsonl`: every trial, including failed and exhausted ones.
- `budget.json`: shared campaign consumption, limits, stop reason, and unrun trial count.
- Per-trial fixtures, immutable oracle source, prompts, RPC output, stderr, parent and
  child sessions, response files, `trace.jsonl`, and individual checks/metrics.

The trace records parent and child requests, reported usage, tool calls/errors, job
starts/results, automatic pushes, user follow-ups, probes, and observed file changes.
Parent and child input/output/cache reads/cache writes and reported costs stay separate.
Cached input is not presented as uncached input, and a zero reported cost does not
establish zero billing. Usage can be incomplete for interrupted/failed requests.

First-result latency means a completed job result, not independently verified usefulness.
Parent requests while jobs are pending can be useful work or waste: inspect the trace.
Likewise, a `sleep`/`while` detector is a diagnostic, not a correctness failure. Actual
client/native launch provenance comes from the runtime, rather than regex guesses about
shell commands. `clientRuns` identifies whether the Node client was actually exercised: a
`client` trial that only used `runSubAgents` says nothing about the client.

The progress gate deliberately makes completion depend on independent parent work,
avoiding a benchmark dominated by model response-speed jitter. Its wait time is not a
production latency estimate. File snapshots around tools provide provenance evidence;
concurrent writes can overlap, so they are not OS-level writer attribution. Check raw
traces when drawing conclusions about parent progress or independence.

Prefer correctness and recovery first, then compare latency/context on successful
matched tasks. The default single run is a development check, not a reliability estimate. Do not pool all
cases into a single winner or claim statistical generalization from these fixtures.
No scorer asserts that the Node client or `runSubAgents` is the right
answer merely because that is how the current instructions route the task.

## Offline validation

```bash
npm test
npm run check
```

Offline tests check that unfinished fixtures fail their oracles, correct behavior is
accepted, plausible wrong patches and wrong ordering are rejected, and paired plans and
usage aggregation behave correctly. They do not call providers.

`npm test` also runs the client integration tests against a real Pi runtime, the real
bash tool, and child processes. An unavailable model makes children fail locally before
provider requests; a provider that never answers keeps children running for cancellation
and disconnect cases. These tests do not replace live evaluation of model-generated reports.
