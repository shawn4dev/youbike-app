// lib/notifications.js
// YouBike 低車量推播通知模組（純前端，瀏覽器 Notification API）

// module-level：記錄每個站上次通知的時間戳（ms）
const lastNotified = new Map();

const REPEAT_COOLDOWN_MS = 30 * 60 * 1000; // 30 分鐘

/**
 * 要求通知權限。
 * @returns {Promise<string>} 'granted' | 'denied' | 'default'
 */
export async function ensurePermission() {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'denied';
  }
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

/**
 * 取得目前時間的 HHMM 整數（例：14:05 -> 1405）。
 */
function nowHHMM() {
  const d = new Date();
  return d.getHours() * 100 + d.getMinutes();
}

/**
 * 判斷 now 是否落在 [from, to] 內（HHMM 整數比較）。
 * 支援跨夜區間（from > to，例如 2200 ~ 0700）。
 */
function withinActiveWindow(now, from, to) {
  if (from <= to) return now >= from && now <= to;
  return now >= from || now <= to; // 跨午夜
}

/**
 * 檢查收藏站點並發出低車量通知。
 * 條件全部符合才通知：
 *   1. settings.enabled 為真（未定義時視為啟用）
 *   2. 站點 available <= settings.threshold
 *   3. 現在時間在 settings.activeFrom ~ settings.activeTo（HHMM 整數）內
 *   4. 距離上次通知該站超過 30 分鐘
 *
 * @param {Array<{id:string|number, name?:string, available:number}>} stations
 * @param {Array<string|number>} favorites - 收藏站點 id 陣列
 * @param {{enabled?:boolean, threshold:number, activeFrom:number, activeTo:number}} settings
 * @returns {string[]} 本次實際發出通知的站點 id
 */
export function maybeNotify(stations, favorites, settings) {
  if (typeof window === 'undefined' || !('Notification' in window)) return [];
  if (!settings || settings.enabled === false) return [];
  if (Notification.permission !== 'granted') return [];

  const favSet = new Set(favorites);
  const now = Date.now();
  const nowT = nowHHMM();
  const threshold = Number(settings.threshold) || 0;
  const from = Number(settings.activeFrom);
  const to = Number(settings.activeTo);
  const notified = [];

  for (const station of stations || []) {
    if (!favSet.has(station.id)) continue;
    if (!(Number(station.available) <= threshold)) continue;
    if (!withinActiveWindow(nowT, from, to)) continue;

    const prev = lastNotified.get(station.id) || 0;
    if (now - prev <= REPEAT_COOLDOWN_MS) continue;

    try {
      new Notification(`🚲 ${station.name || station.id} 車輛不足`, {
        body: `目前僅剩 ${station.available} 台可借（門檻 ${threshold}）`,
        tag: String(station.id),
      });
      lastNotified.set(station.id, now);
      notified.push(station.id);
    } catch {
      // 個別通知失敗不中斷其他站點
    }
  }

  return notified;
}

/** 測試／重置用：清除所有站點的冷卻紀錄 */
export function resetNotifyCooldowns() {
  lastNotified.clear();
}
