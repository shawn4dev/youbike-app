export function requestDeviceLocation({ geolocation, onPosition, onUnavailable }) {
  let cancelled = false;
  let bestAccuracy = Infinity;
  const accept = position => {
    if (cancelled || !Number.isFinite(position.coords.latitude) || !Number.isFinite(position.coords.longitude)) return;
    const accuracy = position.coords.accuracy ?? Infinity;
    if (accuracy > bestAccuracy) return;
    bestAccuracy = accuracy;
    onPosition({ lat: position.coords.latitude, lng: position.coords.longitude, accuracy });
  };
  const refine = () => {
    if (!cancelled) geolocation.getCurrentPosition(accept, () => {}, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  };
  if (!geolocation) onUnavailable(new Error('此瀏覽器不支援定位'));
  else geolocation.getCurrentPosition(
    position => { accept(position); refine(); },
    error => { if (!cancelled) { onUnavailable(error); if (error.code !== 1) refine(); } },
    { enableHighAccuracy: false, timeout: 2500, maximumAge: 300000 }
  );
  return () => { cancelled = true; };
}
