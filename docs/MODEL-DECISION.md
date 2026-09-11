# Model and runtime decision — 11 September 2026

Use **OpenCV 4.10 CPU DNN + YuNet 2023mar + SFace FP32**, with **hnswlib 0.8.0** for nearest-neighbor
matching and **SQLite 3.50.4** for durable records. The inference engine is statically linked
Linux x86-64. Version 1.2 embeds it in a Bun executable with Better Auth passkeys, matching PDF
Signer's authentication. There is no Python, ONNX Runtime, GPU dependency, or external inference API.

## Current Nibrun constraints

The current service advertises 1 vCPU, 256 MiB RAM and 8 GiB persistent storage.
The inspected API source permits binary uploads of up to 256 MiB. The application binary is
approximately 89.4 MiB including Bun/Better Auth and the 9 MiB engine; model weights are downloaded
separately to the persistent volume. Nibrun sampled 165.2 MiB RAM after passkey and 16-megapixel
photo tests, below its 256 MiB limit.

Sources: [Nibrun](https://nibrun.com/),
[artifact size implementation](https://github.com/ilbertt/nibrun/blob/main/apps/api/src/services/artifacts.service.ts),
[guest contract](https://github.com/ilbertt/nibrun/blob/main/skills/deploy-to-nibrun/SKILL.md).

## Alternatives considered

| Option | Evidence and tradeoff | Decision |
| --- | --- | --- |
| YuNet + SFace FP32 | YuNet is 232,589 bytes; SFace is about 37 MB. The weights already fit the disk budget, and OpenCV has built-in alignment/embedding APIs. | Selected. |
| SFace INT8 | Downloaded and loaded successfully; the model is 9,896,933 bytes. In a 10-inference local comparison on one aligned OpenCV sample face, it took about 34.9 ms per embedding versus 13.6 ms for FP32. | Smaller storage did not justify the measured slowdown in this local check. |
| SFace block-quantized | OpenCV publishes a block-quantized variant and reports comparable benchmark accuracy. Operator support, actual RAM savings and collection-specific thresholds still need deployment validation. | No demonstrated benefit needed to meet this app's limits; not selected. |
| InsightFace buffalo_sc (SCRFD-500MF + MobileFaceNet) | Official model zoo lists a 16 MB pack with stronger published results on some benchmarks. Its downloadable weights are restricted to non-commercial research, and integrating it would require a new detection/alignment path. | Not selected for a general reusable app. |
| Other MobileFaceNet exports | The paper describes compact recognition networks. OpenCV's SFace model itself encodes a MobileFaceNet trained with SFace loss; the architecture name alone does not establish that another checkpoint is better. | Require a validated checkpoint, preprocessing and threshold before replacing SFace. |
| ONNX Runtime / OpenCV 5 ORT engine | Adds another runtime for a job already handled by the compact static OpenCV build. YuNet's 2026may update re-exports dynamic dimensions for that engine rather than supplying a newly trained detector. | Retain OpenCV 4.10's native CPU DNN path. |
| FAISS / HNSW | Both can avoid exhaustive all-pairs matching. hnswlib provides header-only C++ HNSW, inner-product distance, dynamic capacity and serialization without introducing BLAS or a separate service. | hnswlib selected. |

Sources: [OpenCV YuNet](https://github.com/opencv/opencv_zoo/blob/main/models/face_detection_yunet/README.md),
[OpenCV SFace](https://github.com/opencv/opencv_zoo/blob/main/models/face_recognition_sface/README.md),
[InsightFace model zoo](https://github.com/deepinsight/insightface/tree/master/model_zoo),
[MobileFaceNets paper](https://arxiv.org/abs/1804.07573),
[hnswlib](https://github.com/nmslib/hnswlib), [FAISS](https://github.com/facebookresearch/faiss).

The INT8/FP32 timing is a small compatibility/speed check on local Apple Silicon with OpenCV 5,
not a broad accuracy evaluation or a benchmark of Nibrun's x86 CPU. It supports retaining the
known working FP32 baseline, not a claim that FP32 is universally faster. Published accuracy
numbers from different models/datasets are not interchangeable. Validate thresholds against the
owner's actual photo collection.

## Pinning and processing

Model download paths use OpenCV Zoo commit `47534e27c9851bb1128ccc0102f1145e27f23f98`.

| Model | SHA-256 |
| --- | --- |
| `face_detection_yunet_2023mar.onnx` | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` |
| `face_recognition_sface_2021dec.onnx` | `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` |

Detection uses five landmarks for SFace alignment, normalizes all 128-dimensional vectors,
and applies cosine similarity via HNSW inner-product distance. The default match threshold is
`0.363`, matching the OpenCV SFace example; the application exposes it as a user setting.
All grouping corrections are persisted separately from the vector values.

## Tilted faces — version 1.3

Retain the existing model pair and embedding space. The missed sideways face in the supplied
screenshot was a detection problem: the original upright pass found zero faces, while rotation
handling found one. Detection now sweeps eight orientations at 45-degree intervals, each bounded
to a 640-pixel longest edge, and suppresses duplicate boxes across passes. Bounding boxes and all
five landmarks are mapped back before aligning the original pixels for SFace.

A local test found one face at each of 15 tested rotations from −135° through 180°, where the
upright-only detector missed 11. All rotated embeddings matched the upright view at the existing
0.363 threshold (lowest observed cosine 0.547). A combined upright/sideways image yielded exactly
two detections. The compiled OpenCV 4.10 Linux app also passed sideways matching and mixed-photo
tests on Nibrun. These are targeted regression checks, not a general pose-accuracy benchmark.

All eight passes run sequentially so an upright face cannot hide a sideways face in the same
photo. This increases detection CPU time but adds no model weights or concurrent inference
workers. The current SFace embeddings, HNSW index and similarity setting remain compatible.
