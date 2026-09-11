import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { root, run } from './lib.ts';

// A fresh localhost library owns only public fixtures and virtual credentials.
// Never point automated owner-registration tests at a personal deployment.
const binary = resolve(process.env.APP_BINARY || join(root, 'apps/backend/dist/face-library'));
const coreBuild = resolve(process.env.CORE_BUILD_DIR || join(root, 'build', process.platform === 'darwin' ? 'core-local' : 'core-release'));
const chrome = process.env.CHROME_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : Bun.which('google-chrome') || Bun.which('chromium'));
if (!chrome || !Bun.which('ffmpeg')) throw Error('Install Chrome/Chromium and ffmpeg before running browser tests.');
await mkdir(join(root, 'build'), { recursive: true });
const out = await mkdtemp(join(root, 'build/browser-'));
const fixtures = join(out, 'fixtures');
const data = join(out, 'data');
const rotations = join(out, 'rotations');
await mkdir(fixtures); await mkdir(data); await mkdir(rotations);
for (const [filename, sample] of [['lena.jpg', 'lena.jpg'], ['messi.jpg', 'messi5.jpg']]) {
  const response = await fetch(`https://raw.githubusercontent.com/opencv/opencv/4.10.0/samples/data/${sample}`);
  if (!response.ok) throw Error(`Could not download test fixture ${sample}`);
  await Bun.write(join(fixtures, filename!), response);
}
await run([join(coreBuild, 'make-fixtures'), fixtures]);
const video = join(out, 'camera.y4m');
await run(['ffmpeg', '-loglevel', 'error', '-i', join(fixtures, 'lena.jpg'),
  '-vf', 'scale=480:480,pad=640:480:80:0', '-pix_fmt', 'yuv420p', '-frames:v', '1', video]);
// Let the OS allocate a free HTTP port; the engine needs a second free port.
const reserve = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
const port = reserve.port;
const reserveCore = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
const corePort = reserveCore.port;
reserve.stop(true); reserveCore.stop(true);
const base = `http://localhost:${port}`;
const env = { ...process.env, CHROME_PATH: chrome, DATA_DIR: data, PORT: String(port),
  FACE_CORE_PORT: String(corePort), NIBRUN_HOSTNAME: '', NIBRUN_DATA_DIR: '', BASE_URL: base };
const server = Bun.spawn([binary], { cwd: root, env,
  stdout: Bun.file(join(out, 'server.log')), stderr: Bun.file(join(out, 'server-error.log')) });
try {
  let ready = false;
  for (let i = 0; i < 600; i++) {
    if (server.exitCode !== null) throw Error(`Test server exited; see ${out}/server.log`);
    try {
      const response = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).status === 'ready') { ready = true; break; }
    } catch { /* Startup includes downloading and verifying the models. */ }
    await Bun.sleep(500);
  }
  if (!ready) throw Error(`Models did not become ready; see ${out}/server.log`);
  await run([join(coreBuild, 'orientation-test'), join(data, 'models'), join(fixtures, 'lena.jpg'), rotations], env);
  await run([process.execPath, 'tests/browser/passkey-browser.mjs', base,
    join(fixtures, 'lena.jpg'), video, join(out, 'passkey')], env);
  await run([process.execPath, 'tests/browser/preview-browser.mjs', base,
    fixtures, rotations, join(out, 'preview'), join(out, 'passkey/test-credential.json')], env);
  console.log(`Browser checks passed. Local test output: ${out}`);
} finally {
  server.kill('SIGTERM');
  await server.exited;
}
