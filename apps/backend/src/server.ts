import { SQL } from 'bun';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAuth } from './better-auth.ts';
import { OWNER_USER_ID, ownerRegistrationStatus } from './owner-registration.ts';
import schema from './schema.sql' with { type: 'text' };
import { assets, coreAsset } from './assets.gen.ts';

process.umask(0o077);
const data = resolve(process.env.NIBRUN_DATA_DIR || process.env.DATA_DIR || './data');
await mkdir(data, { recursive: true });
const port = Number(process.env.NIBRUN_HTTP_PORT || process.env.PORT || 3000);
const baseUrl = new URL(process.env.NIBRUN_HOSTNAME
  ? `https://${process.env.NIBRUN_HOSTNAME}`
  : process.env.BASE_URL || `http://localhost:${port}`);
const secretPath = join(data, '.better-auth-secret');
try {
  await writeFile(secretPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
const secret = (await readFile(secretPath, 'utf8')).trim();
if (secret.length < 32) throw Error('Invalid stored authentication secret');
const database = new SQL({ adapter: 'sqlite', filename: join(data, 'auth.sqlite') });
await database.unsafe('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
await database.unsafe(schema);
const auth = createAuth({ database, baseUrl, secret });

async function ownerState() {
  const [row] = await database`SELECT EXISTS(SELECT 1 FROM auth_user WHERE id=${OWNER_USER_ID}) owner,
    EXISTS(SELECT 1 FROM auth_passkey WHERE userId=${OWNER_USER_ID}) passkey`;
  return ownerRegistrationStatus({ ownerExists: Boolean(row.owner), passkeyExists: Boolean(row.passkey) });
}
await ownerState(); // Fail closed if a database restore left incomplete ownership state.

const runtime = join(data, 'runtime');
await mkdir(runtime, { recursive: true });
const coreBytes = await Bun.file(coreAsset).bytes();
const coreHash = new Bun.CryptoHasher('sha256').update(coreBytes).digest('hex');
const corePath = join(runtime, `face-core-${coreHash.slice(0,16)}`);
if (!await Bun.file(corePath).exists()) {
  await writeFile(`${corePath}.tmp`, coreBytes, { mode: 0o700 });
  await rename(`${corePath}.tmp`, corePath);
}
await chmod(corePath, 0o700);
const coreToken = randomBytes(32).toString('hex');
const corePort = Number(process.env.FACE_CORE_PORT || port + 1);
const coreOrigin = `http://127.0.0.1:${corePort}`;
const core = Bun.spawn([corePath], {
  env: { ...process.env, NIBRUN_HOSTNAME: '', NIBRUN_DATA_DIR: data,
    FACE_CORE_PORT: String(corePort), FACE_CORE_TOKEN: coreToken },
  stdout: 'inherit', stderr: 'inherit',
});
const coreHeaders = { Authorization: `Bearer ${coreToken}`, 'X-Requested-With': 'FaceLibrary' };
let stopping = false;
core.exited.then(code => {
  if (!stopping) { console.error(`Face engine stopped (${code})`); process.exit(1); }
});
for (let attempt = 0; attempt < 100; attempt++) {
  try {
    const response = await fetch(`${coreOrigin}/health`, { headers: coreHeaders, signal: AbortSignal.timeout(1000) });
    if (response.ok) break;
  } catch { /* The embedded engine is still starting. */ }
  if (attempt === 99) { core.kill(); throw Error('Face engine did not start'); }
  await Bun.sleep(100);
}

function json(body: unknown, status = 200) { return Response.json(body, { status }); }
function secure(response: Response) {
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'same-origin');
  response.headers.set('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.headers.set('Permissions-Policy', 'camera=(self), microphone=(), publickey-credentials-create=(self), publickey-credentials-get=(self)');
  return response;
}
async function handle(request: Request) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'OPTIONS') return json({ error: 'Cross-origin requests are disabled' }, 403);
  if (request.method === 'GET' || request.method === 'HEAD') {
    const file = assets.get(path === '/' ? '/index.html' : path);
    if (file) return new Response(Bun.file(file));
  }
  const origin = request.headers.get('Origin');
  if (origin && origin !== baseUrl.origin) return json({ error: 'Cross-origin requests are disabled' }, 403);
  if (path === '/api/owner' && request.method === 'GET') return json(await ownerState());
  if (path.startsWith('/api/auth/')) {
    // The owner can add backup passkeys; deleting the last one must never reopen signup.
    if (path === '/api/auth/passkey/delete-passkey') return json({ error: 'Passkey removal is not enabled' }, 403);
    return auth.handler(request);
  }
  if (path !== '/health') {
    if (!path.startsWith('/api/') && !path.startsWith('/assets/')) return json({ error: 'Not found' }, 404);
    const session = await auth.getSession(request.headers);
    if (!session || session.user.id !== OWNER_USER_ID) return json({ error: 'Sign in with your passkey to continue.' }, 401);
    if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('X-Requested-With') !== 'FaceLibrary')
      return json({ error: 'Missing request header' }, 403);
  }
  const headers = new Headers(coreHeaders);
  for (const name of ['Content-Type', 'Content-Length', 'Range']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const response = await fetch(`${coreOrigin}${path}${url.search}`, {
    method: request.method, headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    signal: request.signal, redirect: 'error',
  });
  return new Response(response.body, { status: response.status, headers: response.headers });
}
const server = Bun.serve({ hostname: '0.0.0.0', port, maxRequestBodySize: 20 * 1024 * 1024,
  idleTimeout: 60,
  async fetch(request) {
    try { return secure(await handle(request)); }
    catch (error) { console.error('Request failed:', error); return secure(json({ error: 'The request could not be completed. Please try again.' }, 500)); }
  },
});
console.log(`Face Library 1.3.0: ${baseUrl.origin} (Better Auth passkeys)`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { stopping = true; server.stop(true); core.kill(); database.close(); process.exit(0); });
}
