# Face Library

[![Deploy on nibrun](https://nibrun.com/button.svg)](https://app.nibrun.com/deploy?name=face-library&binary=https%3A%2F%2Fgithub.com%2Fmassimoalbarello%2Fface-library%2Freleases%2Fdownload%2Fnibrun-latest%2Fface-library&port=3000&minimal)

Keep your photos together and find the people in them. Upload multiple pictures or take a photo
on your device; faces are found and grouped automatically. Give each person a name, follow their
photos, and correct any matches. Sign in with a passkey.

- **Photos** keeps the original files and links to every detected person.
- **Faces** groups individual face views into people, with links back to their photos. The first
  view stays the preview until you choose another with **Use as preview**.
- **Corrections** let you merge people, move views, split groups, and adjust the similarity
  threshold. Confirmed assignments survive automatic regrouping.
- **Camera uploads** work from the Add photos dialog, with a native camera picker on mobile and
  live preview, capture and retake on desktop.
- **Embedding map** displays every face view on a zoomable 2D similarity map with thumbnail icons,
  colors for assigned people, filtering and links to the original photos. Open it from Faces or
  any person's page; select a view to inspect or correct its assignment.

Photos, embeddings and passkeys live on the instance's persistent filesystem. YuNet/SFace run
locally on the CPU, including rotated-face detection; no external face-recognition service is used.

## Run locally

Install Bun (see `.bun-version`), CMake and OpenCV 4.10 or later with DNN and object-detection
modules. On macOS: `brew install cmake opencv`. Then:

```sh
bun install --frozen-lockfile
bun run dev
```

Open [localhost:3000](http://localhost:3000). Create your passkey on the first visit; that user owns
the instance. Add backup passkeys in Settings. Models download and verify their checksums on first
startup, then remain loaded for the lifetime of the process.

Local development uses a compiled app with embedded frontend assets. Restart `bun run dev` after
editing files. Set `DATA_DIR` and `PORT` to change the local data directory and port.

## Deploy

Use the nibrun button above for a prebuilt Linux x86-64 binary. No local compiler is needed.
The first visit lets you create the instance's passkey.

To build and deploy from source, install Docker, Bun and the [nibrun CLI](https://github.com/ilbertt/nibrun):

```sh
nib login
bun install --frozen-lockfile
bun run deploy:nibrun
```

The script saves the exact app slug in the ignored `.nibrun.json` file and reuses it on later
deployments. To update an existing app, pass its slug: `bun run deploy:nibrun YOUR_APP_SLUG`.
Photos, face names, manual groupings and passkeys persist across redeployments.

The app is one executable containing Bun, Better Auth, the UI and a static C++ engine. It fits
Nibrun's 1 vCPU / 256 MiB instance. Models are downloaded separately into `data/models`.

## Repository layout

Following [PDF Signer](https://github.com/massimoalbarello/pdf-signer):

```text
apps/backend/src/        Better Auth, owner sessions, HTTP gateway
apps/backend/engine/     C++ detection, embeddings, HNSW, SQLite and engine tests
apps/backend/test/       Authentication tests
apps/backend/dist/       Generated self-contained executable
apps/frontend/src/       Better Auth browser client
apps/frontend/public/    Photo/face UI, camera controls and local font
scripts/                 Build, browser-test and Nibrun deployment commands
tests/                   Browser and API integration tests
vendor/                  Pinned C++ sources, certificates and dependency licenses
docs/                    Storage, model decisions and validation details
```

## Checks and releases

```sh
bun run build:local
bun run check:all
bun test
bun run test:browser
```

Browser tests require Chrome/Chromium and ffmpeg. They create a disposable localhost library,
use virtual passkeys and a simulated camera, and verify real detection, rotated-face matching,
preview selection and upload behavior. Test data stays under the ignored `build/` directory.

GitHub Actions builds and tests the Linux executable on every pull request and main-branch push.
Successful main builds update the **nibrun-latest** release used by the deploy button, including
SHA-256 checksums and license notices. See [operations](docs/OPERATIONS.md),
[model decisions](docs/MODEL-DECISION.md) and [third-party licenses](THIRD-PARTY.md).

The embedding map uses D3 canvas interactions and UMAP in a browser worker. It fits up to 2,000
distinct embeddings and projects any remaining views onto the same map. All views are included;
thumbnail decoding is bounded to the visible area. Two-dimensional distances are approximate
and do not replace the cosine matching threshold. Details: [embedding map](docs/EMBEDDING-MAP.md).

MIT licensed, like PDF Signer. Dependencies retain their own licenses.
