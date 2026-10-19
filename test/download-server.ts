// A real HTTP server for downloader tests. Each request takes the next behaviour; the last one repeats.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type Behaviour =
  | 'range' // honour Range with 206, else 200 with the whole body
  | 'ignore-range' // always 200 with the whole body
  | { cut: number } // like 'range', but drop the connection after this many body bytes
  | { status: number }
  | { hang: number } // like 'range', but stall after this many body bytes until the client gives up
  | { chunks: number; delayMs: number }; // like 'range', paced

export async function serve(files: Record<string, Buffer>, behaviours: Behaviour[] = ['range']) {
  const requests: { path: string; range?: string }[] = [];
  const server = http.createServer((req, res) => {
    const name = (req.url ?? '/').slice(1);
    const body = files[name];
    const behaviour = behaviours[Math.min(requests.length, behaviours.length - 1)];
    requests.push({ path: name, range: req.headers.range });
    if (!body) { res.writeHead(404).end(); return; }
    if (typeof behaviour === 'object' && 'status' in behaviour) { res.writeHead(behaviour.status).end(); return; }
    const match = behaviour !== 'ignore-range' && /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    const start = match ? Number(match[1]) : 0;
    const slice = body.subarray(start);
    res.writeHead(match ? 206 : 200, {
      'content-length': slice.length,
      ...(match ? { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
    });
    if (typeof behaviour === 'object' && 'cut' in behaviour) {
      // fetch discards chunks still queued when the stream errors, so let the client read them first.
      res.write(slice.subarray(0, behaviour.cut), () => setTimeout(() => res.destroy(), 50));
    } else if (typeof behaviour === 'object' && 'hang' in behaviour) {
      res.write(slice.subarray(0, behaviour.hang));
    } else if (typeof behaviour === 'object' && 'chunks' in behaviour) {
      const size = Math.ceil(slice.length / behaviour.chunks);
      let offset = 0;
      const next = () => {
        if (offset >= slice.length) { res.end(); return; }
        res.write(slice.subarray(offset, offset + size));
        offset += size;
        setTimeout(next, behaviour.delayMs);
      };
      next();
    } else res.end(slice);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
