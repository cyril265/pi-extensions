---
status: accepted
---

# Reserve the conversation during remote startup

Remote Handoff will reserve the handed-off conversation locally while a remote launch is uncertain, use an idempotent launch record to reconcile lost acknowledgments, and transfer ownership only after confirming that remote Pi started. The temporary reservation blocks local continuation because allowing both sides to run during a network partition would split one conversation into competing histories.
