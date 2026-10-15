import { type ChildProcess, spawn } from 'node:child_process';

export function exited(child: ChildProcess, command: string): Promise<void> {
  const err: Buffer[] = [];
  child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
  return new Promise((ok, fail) => {
    child.on('error', fail);
    child.on('close', (code) =>
      code === 0
        ? ok()
        : fail(new Error(`${command} exited ${code}: ${Buffer.concat(err).toString()}`)),
    );
  });
}

export function run(command: string, args: string[], stdin?: NodeJS.ReadableStream): Promise<void> {
  const child = spawn(command, args, {
    stdio: [stdin == null ? 'ignore' : 'pipe', 'ignore', 'pipe'],
  });
  stdin?.pipe(child.stdin!);
  return exited(child, command);
}
