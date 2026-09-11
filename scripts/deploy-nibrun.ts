import { join } from 'node:path';
import { root, run } from './lib.ts';

const nib = Bun.which('nib');
if (!nib) throw Error('Install the nibrun CLI and run nib login.');
const config = Bun.file(join(root, '.nibrun.json'));
const configured = await config.exists() ? (await config.json()).slug : undefined;
const requested = process.argv[2];
const slug = requested || configured;
if (slug && (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(slug)))
  throw Error('Use the exact app slug as the argument or in .nibrun.json.');
await run([nib, 'apps', 'list']);
await run([process.execPath, 'run', 'build']);
const result = Bun.spawn([nib, '--json', 'run', join(root, 'apps/backend/dist/face-library'),
  ...(slug ? ['--app', slug] : ['--name', 'face-library']), '--port', '3000'],
  { cwd: root, stdout: 'pipe', stderr: 'inherit' });
const output = await new Response(result.stdout).text();
if (await result.exited !== 0) throw Error('Nibrun deployment failed.');
console.log(output);
const deployed = JSON.parse(output);
const saved = deployed.app?.slug || deployed.slug || slug;
if (!saved) throw Error('Deployed; save the app slug printed above in .nibrun.json before redeploying.');
await Bun.write(config, JSON.stringify({ slug: saved }, null, 2) + '\n');
console.log(`https://${saved}.nibrun.app`);
