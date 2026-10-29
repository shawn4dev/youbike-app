export function createStationLoader({ fetchImpl = fetch, onData, onStatus = () => {}, refreshMs = 60000 }) {
  const controller = new AbortController();
  let stopped = false;
  let task = null;
  let lastStations = [];
  let lastFetchedAt = null;

  function refresh({ force = false } = {}) {
    if (stopped) return Promise.resolve();
    if (task) return task;
    onStatus(true);
    task = (async () => {
      try {
        const response = await fetchImpl(`/api/stations${force ? '?force=1' : ''}`, {
          cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data.stations)) throw new Error('站點資料格式錯誤');
        if (stopped) return;
        lastStations = data.stations;
        lastFetchedAt = data.fetchedAt;
        onData({ ...data, updatedStations: data.stations });
      } catch {
        if (!stopped) onData({
          stations: lastStations, updatedStations: [],
          errors: ['三市站點資料更新失敗，保留上次資料'], fetchedAt: lastFetchedAt,
        });
      } finally {
        if (!stopped) onStatus(false);
        task = null;
      }
    })();
    return task;
  }

  const timer = refreshMs > 0 ? setInterval(() => { void refresh(); }, refreshMs) : null;
  return {
    refresh,
    whenIdle: async () => { await task; },
    stop: () => { stopped = true; controller.abort(); if (timer) clearInterval(timer); },
  };
}
