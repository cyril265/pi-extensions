# Use private Git for ordinary directories

Remote Handoff uses a private Git database outside an ordinary project directory instead of introducing a second archive and merge implementation. This keeps snapshots, transfer, concurrent local changes, merge review, and apply behavior identical without creating `.git` in the project.
