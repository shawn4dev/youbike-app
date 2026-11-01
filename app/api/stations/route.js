import { CITIES, createOfficialStations } from '../../../lib/official-stations.mjs';
import { jsonApiResponse } from '../../../lib/api-response.mjs';

export const dynamic = 'force-dynamic';

const officialStations = createOfficialStations();

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const force = params.get('force') === '1';
  const city = params.get('city');
  if (city !== null && !Object.values(CITIES).some(([name]) => name === city)) {
    return jsonApiResponse(request, { error: 'unknown city' }, { status: 400 });
  }
  const payload = await officialStations.get({ force, city });
  return jsonApiResponse(request, payload);
}
