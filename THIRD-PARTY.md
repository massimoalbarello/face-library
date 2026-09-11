# Third-party components

The app incorporates or links the following open-source dependencies. License copies are in
`vendor/` or retained in the source headers. Model files are fetched from the original publisher.

| Component | Version | License / source |
| --- | --- | --- |
| OpenCV | 4.10.0 deployed; local tests also used 5.0.0 | Apache-2.0, https://github.com/opencv/opencv |
| YuNet weights | 2023mar | MIT, https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet |
| SFace weights | 2021dec FP32 | Apache-2.0, https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface |
| hnswlib | 0.8.0 | Apache-2.0, `vendor/HNSW-LICENSE` |
| cpp-httplib | 0.20.1 | MIT, `vendor/HTTPLIB-LICENSE` |
| nlohmann/json | 3.12.0 | MIT, embedded in `vendor/json.hpp` |
| SQLite | 3.50.4 | Public domain, https://sqlite.org/copyright.html |
| Mbed TLS | 3.6.4 | Apache-2.0 or GPL-2.0-or-later; used under Apache-2.0, `vendor/MBEDTLS-LICENSE` |
| libjpeg-turbo | supplied by OpenCV 4.10.0 | BSD-style/IJG/zlib notices in `vendor/OPENCV-THIRD-PARTY/` |
| OpenJPEG | supplied by OpenCV 4.10.0 in the Docker build | BSD-2-Clause, `vendor/OPENCV-THIRD-PARTY/libopenjp2-LICENSE` |
| libpng | supplied by OpenCV 4.10.0 | libpng license in `vendor/OPENCV-THIRD-PARTY/` |
| zlib | supplied by OpenCV 4.10.0 | zlib license in `vendor/OPENCV-THIRD-PARTY/` |
| Protocol Buffers | supplied by OpenCV 4.10.0 | BSD-3-Clause, `vendor/OPENCV-THIRD-PARTY/` |
| DM Sans Variable | Fontsource package 5.2.8, Latin normal weights | SIL Open Font License 1.1, `vendor/DM-SANS-LICENSE` |
| Better Auth and official passkey plugin | 1.7.4 | MIT, `vendor/BETTER-AUTH-LICENSE` |
| Bun SQL auth adapter | 0.4.0 | Unlicense, `vendor/BUN-SQL-ADAPTER-LICENSE` |
| Bun runtime | 1.4.0 | MIT; runtime third-party notices: https://github.com/oven-sh/bun/blob/main/LICENSE.md |
| SimpleWebAuthn server/browser | Versions pinned by `bun.lock` | MIT, dependency license copies in `vendor/AUTH-LICENSES/` |
| PDF Signer authentication and UI reference | `5ff828f` | MIT, `vendor/PDF-SIGNER-LICENSE` |
| D3 zoom, selection and quadtree | 3.0.0 / 3.0.0 / 3.0.1 | ISC, including transitive D3 modules in `vendor/MAP-LICENSES/` |
| umap-js | 1.4.0 | Apache-2.0 per bundled LICENSE (package metadata says MIT); `vendor/MAP-LICENSES/` |
| UMAP math dependencies | Versions pinned by `bun.lock` | MIT/ISC; license copies in `vendor/MAP-LICENSES/` |

The build embeds a CA trust bundle from the development system for authenticated HTTPS model
downloads. Its PEM comments identify the included certificate authorities. This bundle should
be refreshed periodically when rebuilding, without disabling certificate or checksum validation.

OpenCV's `lena.jpg` and `messi5.jpg` sample images were used only for verification. They are not
bundled with the app or left in the deployed library. The frontend contains no external fonts,
tracking, remote image services or externally hosted application scripts.

PDF Signer was consulted for the single-binary deployment structure, persistent-data design,
and neutral UI theme, typography, sidebar and control styles.
The passkey owner-registration policy and Better Auth configuration are adapted from PDF Signer.
The app uses the official Better Auth passkey plugin and browser client, with resident credentials
and required user verification. Its C++ photo/embedding engine remains separate from authentication.
