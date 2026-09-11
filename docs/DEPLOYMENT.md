# Deployment artifacts

The README deploy button uses the executable named `face-library` in the public
[nibrun-latest release](https://github.com/massimoalbarello/face-library/releases/tag/nibrun-latest).
GitHub Actions updates that release only after the Linux build, type checks, authentication,
index and browser/inference tests pass. Each release includes `SHA256SUMS` and license notices.

Use `bun run deploy:nibrun YOUR_APP_SLUG` to rebuild and update an existing instance.
All state belongs under `NIBRUN_DATA_DIR`, falling back to `DATA_DIR` or `./data` locally.
Do not seed a public release with a personal library or authentication database.

The 1.3 upgrade backfills each face's preview from its earliest view and retries completed
photos with no detected views once. Original bytes, existing views, embeddings, names, manual
assignments and passkeys remain intact.
