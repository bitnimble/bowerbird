import type { BunFile } from 'bun';

export function fileResponse(
  file: BunFile,
  headers: ConstructorParameters<typeof Headers>[0],
  range: string | undefined,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Length', String(file.size));
  const match = /^bytes\s*=\s*(\d*)-(\d*)\s*$/i.exec(range ?? '');
  if (match == null || (match[1] === '' && match[2] === ''))
    return new Response(file, { headers: responseHeaders });

  const start = match[1] === '' ? Math.max(0, file.size - Number(match[2])) : Number(match[1]);
  const end =
    match[1] === '' || match[2] === '' ? file.size - 1 : Math.min(Number(match[2]), file.size - 1);
  if (match[1] !== '' && match[2] !== '' && Number(match[2]) < start)
    return new Response(file, { headers: responseHeaders });
  if (start >= file.size || file.size === 0) {
    responseHeaders.set('Content-Range', `bytes */${file.size}`);
    responseHeaders.set('Content-Length', '0');
    return new Response(null, { status: 416, headers: responseHeaders });
  }

  responseHeaders.set('Content-Range', `bytes ${start}-${end}/${file.size}`);
  responseHeaders.set('Content-Length', String(end - start + 1));
  // Reading a BunFile response body loses its slice end; stream the bounded slice.
  return new Response(file.slice(start, end + 1).stream(), {
    status: 206,
    headers: responseHeaders,
  });
}
