import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from 'bun:sqlite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright-core');
const [base, fixtures, rotations, out, credentialPath] = process.argv.slice(2);
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname) || !process.env.DATA_DIR?.includes('build/browser-')) throw Error('Requires the disposable localhost library created by scripts/test-browser.ts');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const page = await context.newPage(); page.setDefaultTimeout(30000);
const errors = []; page.on('pageerror', e => errors.push(e.message));
const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: JSON.parse(await readFile(credentialPath, 'utf8')) });
async function api(path, method = 'GET', body) { return page.evaluate(async ({ path, method, body }) => {
  const r = await fetch(path, { method, headers: { 'X-Requested-With': 'FaceLibrary', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}, { path, method, body }); }
async function ready() {
  for (let i = 0; i < 600; i++) {
    const photos = (await api('/api/photos')).data.items;
    if (ids.every(id => photos.some(p => p.id === id && p.status === 'ready'))) return;
    const failed = photos.find(p => ids.includes(p.id) && p.status === 'error');
    if (failed) throw Error(failed.error);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Fixture photos did not finish processing');
}
async function mapReady() { await page.waitForFunction(() => document.querySelector('#map-filter')?.disabled === false && document.querySelector('.map-loading')?.hidden); }
const ids = [];
try {
  assert.equal((await fetch(base + '/api/views/embeddings')).status, 401);
  await page.goto(base); await page.getByRole('button', { name: 'Sign in with passkey', exact: true }).click();
  await page.getByRole('heading', { name: 'Photos', exact: true }).waitFor();
  await page.goto(base + '/#map'); await mapReady();
  assert.match(await page.locator('#map-status').innerText(), /No face views/);
  await page.screenshot({ path: resolve(out, 'empty-map.png') });
  for (const path of [join(fixtures, 'lena.jpg'), join(fixtures, 'lena-darker.jpg'), join(fixtures, 'messi.jpg'), join(rotations, 'tilt-30.jpg'), join(rotations, 'tilt-45.jpg')]) {
    const data = Array.from(await readFile(path));
    const result = await page.evaluate(async ({ data, filename }) => (await (await fetch('/api/photos?name=' + filename, { method: 'POST', headers: { 'X-Requested-With': 'FaceLibrary' }, body: new Uint8Array(data) })).json()), { data, filename: path.split('/').pop() });
    assert.ok(result.id); ids.push(result.id);
  }
  await ready();
  const original = (await api('/api/views/embeddings')).data;
  assert.equal(original.items.length, 5, JSON.stringify((await api('/api/photos')).data.items.map(p => ({name:p.filename,status:p.status,views:p.view_count,error:p.error})))); assert.equal(original.dimensions, 128);
  assert.ok(original.items.every(v => v.embedding.length === 128));
  assert.equal((await api('/api/views/embeddings?after=-1')).status, 400);
  assert.equal((await api('/api/views/embeddings?through=no')).status, 400);
  const faceId = original.items[0].face_id;
  await api('/api/faces/' + faceId, 'PATCH', { name: 'Sample <person>' });
  // Seed repeated real vectors in this owned disposable DB to cross a 500-row API page.
  const db = new Database(join(process.env.DATA_DIR, 'library.sqlite'));
  const source = original.items[0].id;
  db.transaction(() => {
    for (let i = 0; i < 505; i++) {
      const row = db.query('INSERT INTO views(photo_id,face_id,crop,x,y,w,h,confidence,manual) SELECT photo_id,face_id,crop,x,y,w,h,confidence,manual FROM views WHERE id=? RETURNING id').get(source);
      db.query('INSERT INTO embeddings(view_id,vector) SELECT ?,vector FROM embeddings WHERE view_id=?').run(row.id, source);
    }
  })();
  db.close();
  const first = (await api('/api/views/embeddings')).data;
  assert.equal(first.items.length, 500); assert.equal(first.done, false);
  const last = (await api(`/api/views/embeddings?after=${first.next}&through=${first.through}`)).data;
  assert.equal(last.items.length, 10); assert.equal(last.done, true);
  const all = [...first.items, ...last.items];
  assert.equal(new Set(all.map(v => v.id)).size, 510);
  const before = all.map(({ id, face_id, embedding }) => ({ id, face_id, embedding }));
  await page.getByRole('button', { name: 'Refresh map', exact: true }).click(); await mapReady();
  await page.waitForFunction(() => Number(document.querySelector('#embedding-canvas')?.dataset.thumbnails) > 0);
  assert.equal(await page.locator('#embedding-canvas').getAttribute('data-views'), '510');
  assert.match(await page.locator('#map-method').innerText(), /UMAP/);
  assert.equal(await page.locator('img[src=x]').count(), 0);
  await page.screenshot({ path: resolve(out, 'embedding-map-desktop.png'), fullPage: true });
  // Pick a genuinely rendered colored thumbnail, through a real pointer click.
  const hit = await page.locator('#embedding-canvas').evaluate(canvas => {
    const context = canvas.getContext('2d'), { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const ratio = canvas.width / canvas.clientWidth;
    for (let y = 8; y < canvas.height - 8; y += 3) for (let x = 8; x < canvas.width - 8; x += 3) {
      const i = (y * canvas.width + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 70 && data[i + 3] > 200) return { x: x / ratio, y: y / ratio };
    }
  });
  assert.ok(hit); await page.locator('#embedding-canvas').click({ position: hit });
  await page.getByRole('link', { name: 'Open photo →', exact: true }).waitFor();
  assert.match(await page.getByRole('link', { name: 'Open face →', exact: true }).getAttribute('href'), /^#face\/\d+$/);
  const zoomBefore = Number(await page.locator('#embedding-canvas').getAttribute('data-zoom'));
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.waitForFunction(k => Number(document.querySelector('#embedding-canvas').dataset.zoom) > k, zoomBefore);
  await page.locator('#map-filter').selectOption(String(faceId));
  await page.waitForFunction(count => Number(document.querySelector('#embedding-canvas').dataset.views) === count, all.filter(v => v.face_id === faceId).length);
  assert.equal(Number(await page.locator('#embedding-canvas').getAttribute('data-views')), all.filter(v => v.face_id === faceId).length);
  await page.locator('#embedding-canvas').focus(); await page.keyboard.press('ArrowRight');
  assert.ok(await page.getByRole('button', { name: 'Next view', exact: true }).isVisible());
  await page.getByRole('button', { name: 'Next view', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.screenshot({ path: resolve(out, 'embedding-map-mobile.png'), fullPage: true });
  const freshFirst = (await api('/api/views/embeddings')).data;
  const freshLast = (await api(`/api/views/embeddings?after=${freshFirst.next}&through=${freshFirst.through}`)).data;
  assert.deepEqual([...freshFirst.items, ...freshLast.items].map(({ id, face_id, embedding }) => ({ id, face_id, embedding })), before, 'Projection must not mutate vectors or groups');
  await page.getByRole('button', { name: 'Move or split this view', exact: true }).click();
  await page.getByRole('button', { name: 'Create a new face', exact: false }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL(/#face\/\d+$/);
  await page.getByRole('link', { name: 'Embedding map', exact: true }).click(); await mapReady();
  assert.notEqual(await page.locator('#map-filter').inputValue(), String(faceId));
  await page.getByRole('button', { name: 'Refresh map', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.match(await page.locator('#map-status').innerText(), /cancelled/);
  await page.getByRole('button', { name: 'Refresh map', exact: true }).click(); await mapReady();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in with passkey', exact: true }).waitFor();
  assert.equal(await page.locator('#embedding-canvas').count(), 0);
  assert.equal((await api('/api/views/embeddings')).status, 401);
  assert.deepEqual(errors, []);
  await page.getByRole('button', { name: 'Sign in with passkey', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  await page.goto(base + '/#photos');
  await page.getByRole('heading', { name: 'Photos', exact: true }).waitFor();
  console.log('PASS embedding map: auth, 510 views across API pages, real thumbnails/picking, UMAP, colors/filter, zoom, keyboard, mobile, grouping links/correction, cancel, logout cleanup, unchanged vectors');
} finally {
  for (const id of ids) await api('/api/photos/' + id, 'DELETE').catch(() => {});
  const saved = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials[0];
  if (saved) await writeFile(credentialPath, JSON.stringify(saved), { mode: 0o600 });
  await browser.close();
}
