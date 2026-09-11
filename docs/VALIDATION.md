# Validation — 11 September 2026

The self-contained Linux x86-64 app was validated locally and on Nibrun. Version 1.3 tests used disposable local and Nibrun libraries; the user's
populated production library was not used for test uploads or grouping edits.

## Uploads, previews and tilted faces (1.3.0)

- Browser tests passed locally and on the compiled OpenCV 4.10 Linux app on Nibrun: the upload
  choices appear only after **Add photos**, successful uploads remove their progress panel,
  errors remain dismissible, and desktop/mobile layouts have no horizontal overflow.
- Actual file and simulated-camera uploads, first/backup passkey creation, returning sign-in,
  sign-out and protected original downloads continue to pass through Better Auth.
- Preview tests cover the earliest detected view, user selection, refresh persistence, later
  uploads, invalid cross-person selection and fallback after moving/deleting the selected view.
  Merging retains the target person's valid preview.
- A 15-angle portrait test found exactly one face for every tested rotation. All embeddings
  still matched the upright reference (minimum cosine 0.547 versus threshold 0.363). The old
  detector missed 11 of these angles. The user's attached tilted-face screenshot changed from
  zero detections to one. A mixed upright/sideways fixture produced two detections; a blank
  image produced none. Sideways matching and mixed orientations also passed on Nibrun.
- A populated disposable 1.2 library was upgraded to 1.3. Original bytes, existing embeddings,
  face names and confirmed assignments were unchanged; earliest previews were backfilled and
  the previously missed sideways photo was automatically recovered into its named group.
  The old virtual passkey signed in successfully after the upgrade.
- Existing authentication unit tests and the 10,000-vector index regression test passed.
- Final binary: **89.4 MiB**. Nibrun sampled **174.5 MiB / 256 MiB** after the staging browser and
  inference suite. Eight sequential detector passes trade additional CPU time for orientation
  coverage. The sample is not continuous peak-memory profiling or a broad accuracy benchmark.

## Better Auth passkey update (1.2.0)

- Uses Better Auth 1.7.4 and its official passkey plugin, following PDF Signer's owner registration
  flow. The access-key form and public key-login endpoint are removed. Legacy bearer keys and
  old session cookies cannot access photos or assets.
- Real WebAuthn ceremonies with Chrome virtual authenticators passed locally and on a disposable
  Nibrun app: first passkey creation, adding an authenticated backup passkey, sign-out, returning
  sign-in, owner-claim rejection for another visitor, cross-origin rejection and protected assets.
- Authenticated file/camera uploads reach actual YuNet/SFace inference; preserved originals and
  face naming were verified through the new session boundary.
- Redeploying the same Linux binary on the temporary app preserved its registered passkeys,
  photo and face name. The saved virtual authenticator signed in successfully after restart.
- Desktop and 390px mobile login layouts were visually inspected against PDF Signer's styling.
- The final Linux binary is about **89.4 MiB**, including Bun, Better Auth and the embedded static
  C++ engine. The engine binds only to loopback and requires a fresh internal token for each run.
- Nibrun reported **99.7 MiB** after initialization and **165.2 MiB** after real browser ceremonies,
  camera uploads and a 4000×4000 PNG, against the **256 MiB** instance limit. These are sampled
  values, not continuous peak-memory profiling.
- At the end of the 1.2 rollout, no test passkey was registered on the user-facing app. It was left at **Create your passkey** for
  the owner. Physical Touch ID/Face ID/security-key confirmation is performed by the user's device.

## Original 1.0 verification

- First-start HTTPS model download and pinned SHA-256 verification; both models load successfully.
- Authenticated access, invalid-key rejection, session login/logout, protected asset routes, and
  rejection of cross-origin mutations and out-of-range thresholds.
- Original JPEG/PNG upload bytes are preserved and downloadable.
- Real YuNet detection and SFace embeddings: duplicate/brightness-variant faces group together;
  different sample people remain separate; multiple faces and no-face images are handled.
- Naming, splitting, moving, merging, and keeping corrections fixed during regrouping.
- Invalid multi-view edits roll back, leaving the original assignments intact.
- A redeploy preserves originals, views, names, manual assignments, and the threshold. A new
  upload after the redeploy matches the saved embedding index correctly.
- A 4000×4000 PNG and 6000×4000 JPEG process successfully. A 4000×4001 PNG reaches the pixel
  guard and is marked with a processing error; the service stays responsive.
- All verification photos, previews, crops and embedding rows are removed afterward.

The full integration suite was run again on the final deployment with `--cleanup`.

## Camera and PDF Signer styling update (1.1.0)

- Matched PDF Signer's DM Sans typography, neutral colors, sidebar, buttons and borders;
  inspected desktop and 390px-wide mobile screenshots.
- Chrome's simulated video camera exercised real browser permission, live preview, capture,
  retake, explicit Use photo, JPEG storage and actual face detection.
- Capture, dialog close and Escape release all video tracks; capturing without Use photo
  creates no stored asset. Denying camera permission displays the recovery controls.
- An emulated phone verified the separate `capture="environment"` input, native-picker upload
  path, repeated-capture reset and unchanged multi-file picker. No horizontal mobile overflow.
- The embedded DM Sans font is served locally, and browser checks reported no JavaScript errors.
- A connection regression test found and fixed idle keep-alive sockets occupying all three
  HTTP workers. Connections now close after each response; three idle clients do not prevent
  a fourth request from completing. Inference and HTTP worker counts remain bounded.
- The full camera browser suite passed both locally and on the final Nibrun 1.1.0 deployment.
  The existing inference/grouping integration suite also passed locally after the connection fix.
  Deployment preserved the library counts and threshold; the live camera tests removed their
  three uploaded test photos afterward. The private access key is unchanged.

Camera tests use a simulated video fixture, not a physical camera. Physical iPhone/Android
camera apps and their device-specific image formats have not been manually tested.

## Original browser verification

Used the real login form, selected multiple files in the file input, opened Photos and Faces,
named a face, selected and split a view, saved a custom threshold, and followed face boxes from
photo details back to a face. Desktop and 390px-wide mobile layouts were inspected. The mobile
layout's document width matches its viewport, without horizontal overflow. One transfer from a
paused hidden browser tab timed out; repeating the batch completed successfully, and its error
was displayed rather than silently dropping the file.

## Scale and resource evidence

- Static binary: about **9 MiB**; verified as an ELF x86-64 executable with no dynamic linker.
- Model data: about **37 MiB** plus **227 KiB** for YuNet.
- Nibrun memory reported after initialization: **69,541,888 bytes (66.3 MiB)**.
- Memory reported after larger-image checks: **133,115,904 bytes (126.9 MiB)**.
- Instance limit: **268,435,456 bytes (256 MiB)**.
- Standalone index test inserts 10,000 synthetic normalized vectors, finds all 1,000 tested
  identical-vector neighbors, and checks same-photo exclusion. The initial local run took about
  2.4 seconds including construction. This is not a real-world face-recognition accuracy study
  or a benchmark of a 50,000-photo library.

The measured memory values are Nibrun samples, not continuous peak-memory profiling. Worst-case
concurrent uploads and the 50,000-view guard were not exhaustively benchmarked. The app bounds
image size, worker concurrency and graph capacity to keep its workload appropriate to the instance.
