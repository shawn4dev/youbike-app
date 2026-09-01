export async function GET() {
  try {
    const response = await fetch('https://ipwho.is/', {
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error(`network location returned ${response.status}`);

    const data = await response.json();
    const lat = Number(data.latitude);
    const lng = Number(data.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('network location has no coordinates');

    return Response.json({ lat, lng, city: data.city ?? null, region: data.region ?? null });
  } catch {
    return Response.json({ error: 'network location unavailable' }, { status: 503 });
  }
}
