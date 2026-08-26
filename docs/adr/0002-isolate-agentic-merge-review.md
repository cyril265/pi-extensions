---
status: accepted
---

# Isolate agentic merge review from the local repository

Remote Handoff will apply directly when local files still match the handoff and use a temporary worktree plus a temporary copy of the handed-off conversation when local files diverged. Git handles clean merges first, Pi reviews the combined result and asks about ambiguity, and the real repository changes only after the developer confirms the final apply-only diff, so leaving review cannot damage local work or consume the prepared result.
