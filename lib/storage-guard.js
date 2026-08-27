// localStorage 容量守衛:超過上限時,由最舊的站開始清理歷史取樣
const MAX_BYTES = 4 * 1024 * 1024; // 4MB 上限(localStorage 通常 5MB)

function estimateSize(obj) {
  try {
    return new Blob([JSON.stringify(obj)]).size;
  } catch {
    return JSON.stringify(obj).length * 2; // UTF-16 近似
  }
}

// 回傳清理後的 history 物件(可能原地刪減)
export function guardHistory(history, maxBytes = MAX_BYTES) {
  if (estimateSize(history) <= maxBytes) return history;

  // 依「最後取樣時間最舊」的站優先整站移除,直到低於上限
  const entries = Object.entries(history);
  entries.sort((a, b) => {
    const la = a[1][a[1].length - 1]?.t ?? 0;
    const lb = b[1][b[1].length - 1]?.t ?? 0;
    return la - lb;
  });

  const cleaned = Object.fromEntries(entries);
  for (const [id] of entries) {
    delete cleaned[id];
    if (estimateSize(cleaned) <= maxBytes * 0.8) break; // 清到 80% 水位
  }
  return cleaned;
}

// 單站取樣降頻:站點太多時拉長最小間隔
export function sampleIntervalMs(trackedCount) {
  if (trackedCount > 40) return 5 * 60 * 1000;   // >40 站:每 5 分鐘
  if (trackedCount > 20) return 2 * 60 * 1000;   // >20 站:每 2 分鐘
  return 60 * 1000;                               // 預設:每分鐘
}

// Haversine 距離(公尺)
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
