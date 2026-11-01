// Gate app-derived work, not Leaflet's own rendering events.
export function attachViewportCommit(map, commit, { delayMs = 0 } = {}) {
  const window = map.getContainer().ownerDocument.defaultView;
  let active = false;
  let timer = null;
  const cancel = () => { window.clearTimeout(timer); timer = null; };
  const request = () => {
    if (active) return;
    cancel();
    if (delayMs) timer = window.setTimeout(() => { timer = null; commit(); }, delayMs);
    else commit();
  };
  const begin = () => { active = true; cancel(); };
  const end = () => { active = false; cancel(); commit(); };
  map.on('moveend resize', request);
  map.on('trackpadzoomstart', begin);
  map.on('trackpadzoomend', end);
  return () => {
    cancel();
    map.off('moveend resize', request);
    map.off('trackpadzoomstart', begin);
    map.off('trackpadzoomend', end);
  };
}

export const formatZoom = zoom => String(Number(zoom.toFixed(2)));
export const zoomMatches = (zoom, sharedZoom) => Math.abs(zoom - sharedZoom) <= .0051;
