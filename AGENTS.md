# Face Library engineering principles

Follow the existing ownership boundaries: the Bun backend owns public authentication and HTTP;
the C++ engine owns persisted library state and inference; the frontend owns interactions.

Treat originals, embeddings, names, manually confirmed assignments and passkeys as durable user
data. Migrations must preserve them unless the requested change explicitly requires otherwise.
Never use a personal deployment for automated registration or destructive integration tests.

Keep model and runtime changes within the documented Nibrun resource budget. Changing embedding
models also changes the meaning of existing vectors and thresholds; establish a migration and
matching validation before replacing them.

Keep generated binaries, model files, credentials and library data out of source control. Publish
the Linux executable through the checked release workflow. Preserve third-party license notices
when changing bundled dependencies.

Use real browser or inference checks when a change crosses those boundaries. Add tests for
observable behavior and data integrity rather than duplicating implementation details.
