import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './lib.ts';

const frontend = join(root, 'apps/frontend');
const outdir = join(frontend, 'dist');
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp(join(frontend, 'public'), outdir, { recursive: true });
const result = await Bun.build({
  entrypoints: [join(frontend, 'src/auth.ts')], outdir,
  naming: 'auth-client.js', target: 'browser', format: 'iife', minify: true,
});
if (!result.success) throw new AggregateError(result.logs, 'Frontend build failed');
// Parse the plain browser scripts too, while keeping their existing output unchanged.
const scripts = await Bun.build({
  entrypoints: [join(frontend, 'public/app.js'), join(frontend, 'public/camera.js')],
  target: 'browser',
});
if (!scripts.success) throw new AggregateError(scripts.logs, 'Invalid browser script');

for (const name of ['embedding-map', 'embedding-worker']) {
  const result = await Bun.build({ entrypoints: [join(frontend, `src/${name}.ts`)],
    outdir, naming: `${name}.js`, target: 'browser', format: 'iife', minify: true });
  if (!result.success) throw new AggregateError(result.logs, `Could not build ${name}`);
}
