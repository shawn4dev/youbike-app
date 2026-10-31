// Leaflet marker/popup/control clicks are not clicks on the map background.
// Programmatic events must not cancel a pending shared-station selection.
export function isMapBackgroundClick(event) {
  const target = event.originalEvent?.target;
  return Boolean(target?.closest) && !target.closest('.leaflet-interactive, .leaflet-marker-icon, .leaflet-popup, .leaflet-control');
}

export function withoutStation(url) {
  const next = new URL(url);
  next.searchParams.delete('station');
  return next;
}
