import { createConnection } from 'node:net';

/** Sends one JSON line to the shell and resolves with the line it answers, or rejects saying why not. */
export function askShell(socketPath: string, request: unknown, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const failed = (why: string): void => reject(new Error(why));
    let reply = '';
    const socket = createConnection(socketPath);
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      failed('it did not answer');
    });
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      const end = chunk.indexOf('\n');
      if (end < 0) {
        reply += chunk;
        return;
      }
      socket.end();
      resolve(reply + chunk.slice(0, end));
    });
    socket.on('end', () => failed('it closed the connection without answering'));
    socket.on('error', (err) => failed(err.message));
  });
}

export function parsedOrNull(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
