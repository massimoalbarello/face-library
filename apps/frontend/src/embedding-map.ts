import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomTransform } from 'd3-zoom';
import { quadtree } from 'd3-quadtree';
import type { EmbeddingView } from './embedding-types.ts';

type Options = { faceId?: number; onMove: (id: number) => void; onExpired: () => void };
const colors = ['#2563eb', '#b45309', '#0d9488', '#9333ea', '#e11d48', '#4d7c0f', '#c2410c', '#0369a1'];
const color = (id: number) => colors[id % colors.length]!;
const name = (v: EmbeddingView) => v.name || `Face ${v.face_id}`;
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function mount(container: HTMLElement, options: Options) {
  container.innerHTML = `<header class="page-head"><div><p class="eyebrow">Faces</p><h1>Embedding map</h1><p class="sub">Every face view, positioned by its visual similarity.</p></div><a class="map-back" href="#faces">Back to Faces</a></header>
    <div class="map-toolbar"><label>Face <select id="map-filter" disabled><option value="">All faces</option></select></label><label>Icon size <input id="map-size" type="range" min="12" max="56" value="32"></label><div class="actions"><button id="map-out" aria-label="Zoom out">−</button><button id="map-in" aria-label="Zoom in">+</button><button id="map-fit">Fit views</button><button id="map-refresh">Refresh map</button></div></div>
    <p id="map-status" role="status" aria-live="polite">Loading embeddings…</p>
    <div class="embedding-layout"><div class="map-stage"><canvas id="embedding-canvas" tabindex="0" role="application" aria-label="Face embedding map. Drag to pan, scroll or pinch to zoom. Arrow keys select views."></canvas><div class="map-loading"><span class="spinner"></span><button id="map-cancel">Cancel</button></div></div>
    <aside class="map-details"><h2>Explore face views</h2><p class="sub">Select a thumbnail to see its person and original photo.</p></aside></div>
    <div class="map-footer"><p id="map-method"></p><p>Colors show assigned faces. This is an approximate 2D view; distances here do not replace the similarity threshold. Overlapping icons can contain multiple views. Zoom in to reveal thumbnails in dense areas.</p></div>`;
  const get = <T extends HTMLElement>(selector: string) => container.querySelector<T>(selector)!;
  const canvas = get<HTMLCanvasElement>('#embedding-canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw Error('Your browser could not create the embedding canvas');
  const context = ctx;
  const stage = get('.map-stage'), status = get('#map-status'), details = get('.map-details');
  const filter = get<HTMLSelectElement>('#map-filter');
  const slider = get<HTMLInputElement>('#map-size');
  let views: EmbeddingView[] = [], filtered: EmbeddingView[] = [], selected: EmbeddingView | undefined;
  let transform: ZoomTransform = zoomIdentity, width = 0, height = 0, frame = 0;
  let destroyed = false, worker: Worker | undefined;
  let tree = quadtree<EmbeddingView>().x(d => d.x).y(d => d.y);
  let loadQueue: EmbeddingView[] = [], activeLoads = 0;
  const loading = new Set<number>(), failed = new Set<number>();
  const images = new Map<number, ImageBitmap>();
  const abort = new AbortController();
  let visible: EmbeddingView[] = [];
  const behavior = zoom<HTMLCanvasElement, unknown>().scaleExtent([0.01, 100000])
    .clickDistance(5).on('zoom', event => { transform = event.transform; schedule(); });
  select(canvas).call(behavior).on('dblclick.zoom', null);

  function schedule() { if (!destroyed && !frame) frame = requestAnimationFrame(draw); }
  function draw() {
    frame = 0;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const size = Number(slider.value);
    visible = filtered.filter(v => {
      const x = transform.applyX(v.x), y = transform.applyY(v.y);
      return x > -size && y > -size && x < width + size && y < height + size;
    });
    // Keep every point on the map, but bound decoded thumbnails and network concurrency.
    // Prioritize the selected view, then points nearest the viewport center.
    const candidates = [...visible].sort((a, b) => a.id === selected?.id ? -1 : b.id === selected?.id ? 1 :
      Math.hypot(transform.applyX(a.x) - width / 2, transform.applyY(a.y) - height / 2) -
      Math.hypot(transform.applyX(b.x) - width / 2, transform.applyY(b.y) - height / 2));
    const covered = new Set<string>(), representatives: EmbeddingView[] = [], overlaps: EmbeddingView[] = [];
    for (const view of candidates) {
      const key = `${view.x},${view.y}`;
      (covered.has(key) ? overlaps : representatives).push(view); covered.add(key);
    }
    const icons = [...representatives, ...overlaps].slice(0, 384);
    const wanted = new Set(icons.map(v => v.id));
    for (const [id, image] of images) if (!wanted.has(id)) { image.close(); images.delete(id); }
    // Draw thumbnail-bearing views last so coincident dots cannot cover their images.
    for (const view of [...visible.filter(v => !images.has(v.id)), ...visible.filter(v => images.has(v.id))]) {
      const x = transform.applyX(view.x), y = transform.applyY(view.y);
      const image = images.get(view.id);
      context.fillStyle = color(view.face_id);
      if (image) {
        context.save(); context.beginPath(); context.arc(x, y, size / 2, 0, Math.PI * 2); context.clip();
        context.drawImage(image, x - size / 2, y - size / 2, size, size); context.restore();
        context.strokeStyle = color(view.face_id); context.lineWidth = 2;
        context.beginPath(); context.arc(x, y, size / 2, 0, Math.PI * 2); context.stroke();
      } else {
        context.beginPath(); context.arc(x, y, wanted.has(view.id) ? size / 2 : 3, 0, Math.PI * 2); context.fill();
      }
    }
    if (selected && filtered.includes(selected)) {
      context.strokeStyle = '#171717'; context.lineWidth = 3;
      context.beginPath(); context.arc(transform.applyX(selected.x), transform.applyY(selected.y), size / 2 + 5, 0, Math.PI * 2); context.stroke();
    }
    loadQueue = icons.filter(v => !images.has(v.id) && !loading.has(v.id) && !failed.has(v.id));
    pump();
    canvas.dataset.views = String(filtered.length);
    canvas.dataset.thumbnails = String(images.size);
    canvas.dataset.zoom = String(transform.k);
  }
  function pump() {
    while (!destroyed && activeLoads < 4 && loadQueue.length) {
      const view = loadQueue.shift()!; loading.add(view.id); activeLoads++;
      fetch(`/assets/views/${view.id}`, { signal: abort.signal, credentials: 'same-origin' })
        .then(async response => {
          if (response.status === 401) { if (!destroyed) options.onExpired(); throw Error('Session expired'); }
          if (!response.ok) throw Error('Thumbnail unavailable');
          const bitmap = await createImageBitmap(await response.blob(), { resizeWidth: 64, resizeHeight: 64 });
          if (destroyed) bitmap.close(); else images.set(view.id, bitmap);
        }).catch(() => failed.add(view.id)).finally(() => {
          loading.delete(view.id); activeLoads--; schedule();
        });
    }
  }
  function fit() {
    if (!filtered.length || !width) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const v of filtered) { minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); }
    const scale = Math.min((width - 110) / Math.max(maxX - minX, 1), (height - 110) / Math.max(maxY - minY, 1));
    select(canvas).call(behavior.transform, zoomIdentity.translate(width / 2, height / 2).scale(Math.max(0.01, scale)).translate(-(minX + maxX) / 2, -(minY + maxY) / 2));
  }
  function choose(view: EmbeddingView, nearby: EmbeddingView[] = [view]) {
    selected = view;
    details.innerHTML = `<img class="map-selected-image" src="/assets/views/${view.id}" alt="Selected face view"><h2><span class="map-color" style="background:${color(view.face_id)}"></span>${escape(name(view))}</h2><p class="sub map-filename">${escape(view.filename)}</p>
      ${nearby.length > 1 ? `<label class="map-overlap">${nearby.length} views here<select id="map-overlap">${nearby.map(v => `<option value="${v.id}" ${v.id === view.id ? 'selected' : ''}>${escape(name(v))} · ${escape(v.filename)} · view ${v.id}</option>`).join('')}</select></label>` : ''}
      <a class="map-link" href="#face/${view.face_id}">Open face →</a><a class="map-link" href="#photo/${view.photo_id}">Open photo →</a><button id="map-move">Move or split this view</button><div class="map-step"><button id="map-prev" aria-label="Previous view">←</button><span>View ${filtered.indexOf(view) + 1} of ${filtered.length}</span><button id="map-next" aria-label="Next view">→</button></div>`;
    const overlap = details.querySelector<HTMLSelectElement>('#map-overlap');
    if (overlap) overlap.onchange = () => choose(nearby.find(v => v.id === Number(overlap.value))!, nearby);
    get('#map-move').onclick = () => options.onMove(view.id);
    get('#map-prev').onclick = () => step(-1);
    get('#map-next').onclick = () => step(1);
    schedule();
  }
  function step(direction: number) {
    if (!filtered.length) return;
    const index = selected ? filtered.indexOf(selected) : -1;
    const next = filtered[(index + direction + filtered.length) % filtered.length]!;
    choose(next);
    const x = transform.applyX(next.x), y = transform.applyY(next.y);
    if (x < 40 || x > width - 40 || y < 40 || y > height - 40)
      select(canvas).call(behavior.transform, zoomIdentity.translate(width / 2, height / 2).scale(transform.k).translate(-next.x, -next.y));
  }
  canvas.onclick = event => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    const radius = Number(slider.value) / 2 + 6;
    const near = tree.find(transform.invertX(x), transform.invertY(y), radius / transform.k);
    if (!near) return;
    const nearby = visible.filter(v => Math.hypot(transform.applyX(v.x) - x, transform.applyY(v.y) - y) <= radius);
    choose(near, nearby);
  };
  canvas.onkeydown = event => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); step(['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1);
    }
  };
  canvas.onmousemove = event => {
    const rect = canvas.getBoundingClientRect();
    const near = tree.find(transform.invertX(event.clientX - rect.left), transform.invertY(event.clientY - rect.top), (Number(slider.value) / 2 + 6) / transform.k);
    canvas.title = near ? `${name(near)} · ${near.filename}` : '';
  };
  filter.onchange = () => {
    filtered = filter.value ? views.filter(v => v.face_id === Number(filter.value)) : views;
    tree = quadtree<EmbeddingView>().x(v => v.x).y(v => v.y).addAll(filtered);
    selected = undefined; details.innerHTML = '<h2>Explore face views</h2><p class="sub">Select a thumbnail, or focus the map and use the arrow keys.</p>';
    status.textContent = `${filtered.length.toLocaleString()} of ${views.length.toLocaleString()} face views`;
    fit(); schedule();
  };
  slider.oninput = schedule;
  get('#map-in').onclick = () => select(canvas).call(behavior.scaleBy, 1.5);
  get('#map-out').onclick = () => select(canvas).call(behavior.scaleBy, 1 / 1.5);
  get('#map-fit').onclick = fit;
  const resize = new ResizeObserver(() => {
    width = stage.clientWidth; height = stage.clientHeight;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    fit(); schedule();
  });
  resize.observe(stage);
  function start() {
    worker?.terminate();
    get('.map-loading').hidden = false;
    filter.disabled = true;
    status.textContent = 'Loading embeddings…';
    worker = new Worker('/embedding-worker.js');
    worker.onmessage = ({ data }) => {
      if (destroyed) return;
      if (data.type === 'expired') { options.onExpired(); return; }
      if (data.type === 'progress') { status.textContent = data.message; return; }
      if (data.type === 'error') { status.textContent = data.message; get('.map-loading').hidden = true; worker?.terminate(); return; }
      if (data.type !== 'complete') return;
      worker?.terminate(); worker = undefined;
      views = data.views;
      const faces = new Map<number, { name: string; count: number }>();
      for (const v of views) { const f = faces.get(v.face_id) || { name: name(v), count: 0 }; f.count++; faces.set(v.face_id, f); }
      const chosen = filter.value || String(options.faceId || '');
      filter.innerHTML = '<option value="">All faces</option>' + [...faces].sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([id, f]) => `<option value="${id}">${escape(f.name)} (${f.count})</option>`).join('');
      filter.value = faces.has(Number(chosen)) ? chosen : '';
      filter.disabled = false; filter.dispatchEvent(new Event('change'));
      get('.map-loading').hidden = true;
      get('#map-method').textContent = `${data.method} · ${data.unique.toLocaleString()} distinct embeddings${data.fitted < data.unique ? ` · Fit on ${data.fitted.toLocaleString()} sampled views, with all remaining views projected onto the same map` : ''}. Group names do not influence the projection.`;
      if (!views.length) status.textContent = 'No face views yet. Add photos to build your map.';
    };
    worker.onerror = () => { status.textContent = 'Could not build the map. Try Refresh map.'; get('.map-loading').hidden = true; worker?.terminate(); };
    worker.postMessage({});
  }
  get('#map-cancel').onclick = () => { worker?.terminate(); worker = undefined; get('.map-loading').hidden = true; status.textContent = 'Projection cancelled. Select Refresh map to try again.'; };
  get('#map-refresh').onclick = start;
  start();
  return () => {
    destroyed = true; worker?.terminate(); abort.abort(); resize.disconnect(); cancelAnimationFrame(frame);
    select(canvas).on('.zoom', null);
    for (const image of images.values()) image.close();
    images.clear();
  };
}

window.FaceMap = { mount };
