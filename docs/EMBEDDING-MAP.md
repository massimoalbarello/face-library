# Face embedding map

Open **Faces → Embedding map** to explore the whole library, or use **Embedding map** on a
person's page to start with that face selected. Every individual view has coordinates derived
from its saved 128-dimensional SFace vector. Colors represent current face assignments. The
projection does not use names or group labels, so incorrect assignments remain visible.

Drag to pan, scroll/pinch or use the buttons to zoom, and choose **Fit views** to reset the
viewport. Select a thumbnail for links to its face and original photo, or **Move or split this
view** for the existing correction controls. Overlapping views can be chosen from a selector.
Arrow keys and Previous/Next view provide keyboard access, including to overlapping views.
Refresh reloads the latest assignments and uploads. Navigation, cancellation and sign-out stop
the projection worker and release thumbnail resources.

## Library choice

- [D3 zoom](https://d3js.org/d3-zoom) handles mouse, touch and programmatic pan/zoom on a canvas;
  D3's [quadtree](https://d3js.org/d3-quadtree) handles nearby-point selection. This avoids a DOM
  image for every view and does not require WebGL.
- [umap-js](https://github.com/PAIR-code/umap-js) performs the nonlinear reduction in a browser
  worker. It runs with a fixed random seed, 300 epochs, up to 15 neighbors and minDist 0.18.
  Euclidean distances between the normalized SFace vectors have the same neighbor ordering as
  cosine distance. Group labels are used only for display and filtering.
- [deck.gl IconLayer](https://deck.gl/docs/api-reference/layers/icon-layer) and
  [ScatterGL](https://github.com/PAIR-code/scatter-gl) support GPU-rendered icon/sprite plots,
  but require texture/atlas management and a WebGL-capable device. D3 plus canvas suits this
  small app without introducing those dependencies.

## Size, memory and interpretation

The authenticated endpoint `/api/views/embeddings` pages at most 500 views per response using
`after` and `through` IDs. It does not load or serialize the whole library in the Nibrun process.
The first page sets an upper ID boundary, so new uploads cannot extend an in-progress scan.
Edits during loading can appear on the next refresh; this is an exploratory view, not a database
snapshot for export. Images continue through the existing authenticated asset routes.

The browser deduplicates exactly identical vectors and gives them identical coordinates.
Libraries with fewer than four distinct vectors use a direct distance-preserving 2D layout.
Larger libraries use UMAP. Above 2,000 distinct vectors, a deterministic uniform sample is fitted
and the remaining vectors are transformed in batches. Every view is represented; the UI states
when fitting used a sample. The existing 50,000-view guard applies to the map.

Rendering includes every visible point, with thumbnails for up to 384 prioritized visible
views and colored dots for denser areas. Four concurrent thumbnail requests and 64×64 decoded
images bound resource use; panning or zooming loads thumbnails for the newly visible area.
There are no external image requests, telemetry, client-side persistence or projection services.

UMAP emphasizes local neighborhoods. Global distances, cluster shapes and apparent separation
can be distorted, and sampling can affect rare groups. The map does not change embeddings,
matching thresholds or grouping automatically. Use the original photos and correction controls
to review uncertain assignments. This visualization is not an identity guarantee.

Tests cover small/duplicate vectors, finite output, deterministic sampling and placement of all
remaining points, authentication, a 510-view paginated library, actual canvas picking, filtering,
zoom, keyboard and mobile interaction, cancellation, sign-out cleanup and unchanged stored data.
