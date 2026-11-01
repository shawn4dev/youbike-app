function acceptedQualities(header) {
  const codings = new Map();
  for (const entry of (header ?? '').split(',')) {
    const [coding, ...parameters] = entry.trim().toLowerCase().split(';');
    const name = coding.trim();
    if (!name) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/.exec(parameter);
      quality = match ? Number(match[1]) : 0;
      if (!match) break;
    }
    codings.set(name, quality);
  }
  return {
    gzip: codings.get('gzip') ?? codings.get('*') ?? 0,
    identity: codings.get('identity') ?? (codings.get('*') === 0 ? 0 : 1),
  };
}

export async function jsonApiResponse(request, payload, { status = 200, headers: initialHeaders } = {}) {
  const headers = new Headers(initialHeaders);
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'no-store');
  headers.delete('Content-Length');
  headers.delete('Content-Encoding');
  const vary = (headers.get('Vary') ?? '').split(',').map(token => token.trim()).filter(Boolean);
  if (!vary.some(token => token === '*' || token.toLowerCase() === 'accept-encoding')) vary.push('Accept-Encoding');
  headers.set('Vary', vary.join(', '));
  if (request.method === 'HEAD' || [204, 205, 304].includes(status)) return new Response(null, { status, headers });

  const { gzip, identity } = acceptedQualities(request.headers.get('Accept-Encoding'));
  if (gzip === 0 && identity === 0) return new Response(null, { status: 406, headers });
  const json = JSON.stringify(payload);
  if (gzip > 0 && gzip >= identity) {
    try {
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
      const compressed = await new Response(stream).arrayBuffer();
      headers.set('Content-Encoding', 'gzip');
      return new Response(compressed, { status, headers });
    } catch {
      if (identity === 0) return new Response(null, { status: 503, headers });
    }
  }
  return new Response(json, { status, headers });
}
