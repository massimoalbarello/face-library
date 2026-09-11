import { resolve } from 'node:path';

export const root = resolve(import.meta.dir, '..');
export async function run(command: string[], env = process.env) {
  const child = Bun.spawn(command, {
    cwd: root, env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
  });
  if (await child.exited !== 0) throw Error(`Command failed: ${command[0]} ${command[1] || ''}`);
}
