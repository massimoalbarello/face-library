# Face Library

A private photo library deployed as one self-contained Linux x86-64 binary on Nibrun. Upload photos,
find face views, group similar views into canonical faces, and give people names.

- **Authentication:** Better Auth passkeys, matching PDF Signer. Create the owner passkey on first
  use, sign in with it afterward, and add backup passkeys in Settings.
- **Photos:** batch upload, processing status, preserved originals, previews, detected face boxes,
  and links to each person.
- **Camera:** take a photo directly from a phone or tablet's native camera picker. Desktop cameras
  have a live preview, Capture, Retake, and Use photo controls. Captures enter the same storage,
  face extraction and grouping pipeline as regular uploads.
- **Faces:** names, all associated views, links back to their photos, search, and pagination.
  The first detected view stays the person's preview. **Use as preview** on any view changes it;
  if that view is removed, the earliest remaining view becomes the preview.
- **Corrections:** merge faces; select views to move to another person or create a separate face.
  Naming or editing a group confirms its current views. Regrouping preserves confirmed views.
- **Similarity:** configurable cosine threshold, initially `0.363`. Save for future uploads or
  explicitly regroup existing automatic assignments. Higher values require a closer match.

## Run

Build with Bun 1.4, CMake, a C++17 compiler, and OpenCV 4.10 or later (core, imgcodecs,
imgproc, dnn, objdetect). CMake downloads pinned Mbed TLS; the remaining C++ libraries are vendored.
The Bun executable embeds Better Auth, its browser client, UI assets and the C++ face engine.

```sh
bun install --frozen-lockfile
bun run build:local
./apps/backend/dist/face-library
```

Open `http://localhost:3000` and choose **Create your passkey**. The first successful WebAuthn
registration owns the workspace, exactly as in PDF Signer. Subsequent visits show **Sign in with
passkey**. There is no password, email form, access-key login, or public API-key bypass.
Only an authenticated owner can register additional passkeys in **Settings → Add a passkey**.
Passkeys require device user verification. Registration cancellation does not create an owner.
The persistent Better Auth database and signing secret keep ownership intact across redeployments.

The interface follows PDF Signer's neutral theme: locally hosted DM Sans, a light sidebar,
white surfaces, dark buttons and restrained borders. On mobile, the sidebar becomes a compact
navigation bar. No font service or external frontend requests are needed.

Choose **Add photos** to open the upload dialog, then **Take a photo** to open the device camera.
The same dialog contains drag-and-drop and the multiple-file picker. Upload progress disappears
when the batch finishes; failed uploads keep a dismissible error message.
The native camera picker on phones
uses the rear camera when supported; the operating system controls its capture and confirmation
screen. Desktop preview requires camera permission and HTTPS (or localhost). Capture stops the
stream and shows a review; only **Use photo** uploads it. Closing the dialog, pressing Escape or
leaving the page releases the camera. A file picker remains available if camera access fails.
Regular **Choose photos** keeps multi-file selection. Browser-decodable camera formats other than
JPEG/PNG are converted to JPEG on the device; unsupported formats display an error.

Supported environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `NIBRUN_HTTP_PORT`, then `PORT` | `3000` | HTTP listener, bound to `0.0.0.0` |
| `NIBRUN_DATA_DIR`, then `DATA_DIR` | `./data` | All persistent state |
| `NIBRUN_HOSTNAME` | unset locally | HTTPS origin and secure session cookies |

## Build and deploy to Nibrun

```sh
bun run build
nib apps list
nib run ./apps/backend/dist/face-library --name face-library --port 3000
```

The Docker stage compiles the C++ engine for Linux x86-64 with musl and static libraries.
Bun then compiles Better Auth and embeds that engine into the final executable. At startup it
extracts the engine into `data/runtime/` and runs it on loopback with an ephemeral internal token.
The Bun server owns public HTTP access and validates the Better Auth owner session before proxying
any library or asset request. Client cookies and authorization headers never reach the engine.
Docker, Python, Node, ONNX Runtime and a GPU are not required on the deployed instance.
Models download on first start to the writable data directory over verified HTTPS and are checked
against pinned SHA-256 hashes. The current executable is about 89.4 MiB, below Nibrun's 256 MiB cap.

Every subsequent deployment must target the same app:

```sh
bun run deploy:nibrun YOUR_APP_SLUG
```

Check `/health` for `status: ready` (the listener can serve the UI while models are preparing).
The authenticated `/api/status` endpoint reports model errors, the queue, and library counts.

## Storage and matching

All state lives under the data directory:

```text
auth.sqlite             Better Auth owner, passkeys, sessions and WebAuthn challenges
.better-auth-secret     Persisted cookie-signing secret (0600)
runtime/                Extracted, versioned C++ engine (owner executable only)
library.sqlite          Photos, faces, views, settings, and an embeddings table
library.sqlite-wal      SQLite WAL, when active
originals/              Original uploaded bytes under random asset names
photos/                 JPEG photo previews
views/                  JPEG face crops
models/yunet.onnx       YuNet, about 227 KB
models/sface.onnx       SFace FP32, about 37 MB
face-index.hnsw         Replaceable HNSW index checkpoint
```

Metadata and embeddings occupy separate normalized tables. Each 128-float embedding is saved as
a 512-byte BLOB and linked to one view. SQLite transactions protect grouping edits and processing
results. The HNSW graph remains loaded in memory; inference models load once per process.
Original photos are saved before processing, and the disk-backed queue resumes interrupted work
on restart. A failed photo retains its original and can be retried or deleted.
Photos without detected views also offer **Find faces again**. The 1.3 upgrade automatically
retries previously completed photos with no views once, using improved orientation handling.
Existing views, embeddings, names and manual assignments are preserved during the upgrade.

Each new normalized embedding searches up to 64 nearest neighbors (`M=16`, construction ef 120,
search ef 100), rather than comparing every pair in the library. It joins the best qualifying
face or creates a new one. Two detections in the same photo are not automatically assigned to the
same face; a manual merge can override that. HNSW is approximate and may miss a match.

The SQLite embeddings are authoritative. HNSW is rebuilt from them on startup so a crash cannot
leave stale grouping data. Checkpoints are saved while idle, at most once every 30 seconds during
imports, and after explicit edits. Building or regrouping the graph is approximately O(n log n)
in typical use, without an all-pairs cosine matrix. Regrouping is deterministic for a given view
order, threshold and confirmed assignments; it does not imply a globally optimal clustering.

## Resource limits

Designed for Nibrun's 1 vCPU / 256 MiB / 8 GiB instance. A Bun authentication server, one inference worker and three engine HTTP workers,
a bounded request queue, and sequential browser uploads limit concurrent memory use.
HTTP connections close after each response so idle clients cannot occupy the small worker pool.
The gateway streams uploads to the engine after checking the owner session.

- JPEG and PNG, up to **20 MiB per file**; multiple files can be selected together.
- JPEGs use reduced-resolution decoding when large. A decoded image may contain at most 16 million
  pixels; oversized PNGs are saved but marked with a processing error instead of exhausting memory.
- Processing uses a photo up to 2048 pixels on its longest edge and a detector image up to 640.
  Detection checks eight orientations sequentially, combines duplicate detections and maps all
  landmarks back to the original image for SFace alignment. This handles sideways and tilted
  faces, including photos that also contain upright faces, at the cost of additional CPU work.
  Original bytes remain untouched. Very small or heavily occluded faces may be missed.
- At most 200 detected views per photo and 50,000 views per instance. These are guards, not a
  claim that the maximum has been benchmarked with real photos.
- The threshold is a starting point, not an identity guarantee. Review matches and correct them.

Naming, moving, splitting or merging confirms all current views in the affected source and target
groups. New views can still join these groups automatically and can be corrected individually.
Confirmed assignments are not reconsidered by the similarity slider. This intentionally gives
human corrections priority. Regrouping waits until the upload-processing queue is empty.

## Validation and backup

`tests/browser/passkey-browser.mjs` uses Chrome's virtual WebAuthn authenticator with the real Better Auth
plugin and SQLite database. It covers first registration, owner-only additional passkeys, sign-out,
returning sign-in, blocked legacy access keys, unauthorized original downloads, file/camera uploads,
face extraction and naming. Run only against a disposable app: the test creates its owner.
Tests default to localhost; remote disposable-app tests require explicit `ALLOW_REMOTE_TESTS=1`.

`tests/browser/preview-browser.mjs` checks upload-dialog visibility, completed progress removal, errors,
first/custom previews and fallback after move/merge/delete, plus rotated and mixed-orientation
photos. It signs in using the disposable credential saved by the passkey test.
`build/core-local/orientation-test MODELS FACE_IMAGE OUTPUT_DIR` checks 15 portrait rotations, embedding agreement,
mixed orientations and blank images with actual inference.

```sh
bun test apps/backend/test/auth.test.ts
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node tests/browser/passkey-browser.mjs \
  http://localhost:3000 /path/to/face.jpg /path/to/camera.y4m /path/to/test-results
# Restart the test server with the same data, then append --returning to the command above.
nib apps export ./face-library-backup.tar.gz --app YOUR_APP_SLUG
```

The test output directory includes a **private virtual-authenticator credential** for restart
verification. It is a disposable test credential, not an end-user passkey; keep it outside source
control. Physical device prompts require the owner to interact with their authenticator.

`tests/api/integration.py` accepts a Playwright storage-state JSON for an already authenticated
disposable owner, and tests the full inference/grouping API contract. The current
passkey browser suite verifies the same capture-to-inference path with Better Auth sessions.

Nibrun's local disk survives redeployments; exporting the app is the backup procedure. Treat the
export as private: it contains sessions, passkey public records, the auth signing secret, photos and biometric embeddings.

See [MODEL-DECISION.md](MODEL-DECISION.md) for the model/runtime comparison and
[THIRD-PARTY.md](../THIRD-PARTY.md) for dependencies and licenses.

The standalone index test inserts 10,000 synthetic normalized vectors and checks 1,000 identity
queries plus same-photo exclusion. It does not represent accuracy on real-world portraits.
Enable it with `-DFACE_LIBRARY_TESTS=ON`, build, then run `ctest --test-dir build/core-local --output-on-failure`.

`bun run test:browser` downloads the public OpenCV sample photos and creates the brightness,
composite, blank and rotated fixtures inside its disposable `build/browser-*` directory.
