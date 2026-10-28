// 在可視地圖外保留一圈緩衝，拖曳時不必立刻重新建立站點圖標。
export function paddedMarkerBounds(bounds, padding = 0.4) {
  const latMargin = (bounds.north - bounds.south) * padding;
  const lngMargin = (bounds.east - bounds.west) * padding;
  return {
    south: bounds.south - latMargin,
    west: bounds.west - lngMargin,
    north: bounds.north + latMargin,
    east: bounds.east + lngMargin,
  };
}

// 目前視野仍落在已渲染的緩衝區內時，無須因小幅拖曳重建圖標。
export function viewportWithinMarkerBounds(viewport, markerBounds) {
  return viewport.south >= markerBounds.south &&
    viewport.west >= markerBounds.west &&
    viewport.north <= markerBounds.north &&
    viewport.east <= markerBounds.east;
}

export function markersWithinBounds(stations, bounds, selectedId = null) {
  return stations.filter((station) => {
    const lat = station.lat;
    const lng = station.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    return station.id === selectedId || (
      lat >= bounds.south && lat <= bounds.north &&
      lng >= bounds.west && lng <= bounds.east
    );
  });
}
