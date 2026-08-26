# Remote Handoff

Remote Handoff moves one developer's active Pi conversation and repository state to a trusted SSH host, then returns the resulting conversation and file changes.

## Language

**Handoff**:
The full lifecycle that starts when work moves to remote Pi and ends when the developer applies or discards its result.

**Workspace**:
The private local and remote resources owned by one handoff.

**Conversation ownership**:
The handed-off conversation can continue in only one Pi process at a time. Other conversations and local repository work remain available while remote Pi owns it.

**Conversation reservation**:
A temporary local lock while Remote Handoff determines whether remote Pi started. The reservation prevents local continuation until remote ownership is confirmed or startup ends without launching.

**Run**:
One continuous remote Pi process inside a handoff. A run can contain many conversation turns.
_Avoid_: Session, when referring to the remote process lifetime

**Detach**:
Leave the remote terminal while remote Pi keeps running.

**Prepared result**:
The remote conversation and file changes made available for local review after remote Pi exits.
_Avoid_: Published result, publication

**Stop**:
End the current run and prepare its conversation and file changes for review.
_Avoid_: Cancel

**Discard**:
End the handoff without applying its prepared result.

**Abandon**:
End a handoff locally when its remote host is permanently unreachable. Remote files, conversation changes, and refreshed credentials remain unrecovered.
_Avoid_: Discard

**Review**:
The period when the developer inspects a prepared result, asks remote Pi questions, and requests further changes before applying it locally.

**Merge review**:
Review required when local work and a prepared result both changed the repository. Pi inspects their combined result, resolves clear conflicts, and asks the developer when intent is ambiguous. The developer confirms the combined diff before it changes local files.
