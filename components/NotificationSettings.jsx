'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';

// settings 形狀（呼叫端負責存 localStorage）：
// {
//   enabled: boolean,
//   threshold: number,     // HHMM 整數以外的門檻，預設 3
//   activeFrom: number,    // HHMM 整數，例如 700 代表 07:00
//   activeTo: number,      // HHMM 整數，例如 2200 代表 22:00
// }
const DEFAULTS = { enabled: false, threshold: 3, activeFrom: 700, activeTo: 2200 };

const pad = (n) => String(n).padStart(2, '0');
const toTimeStr = (hhmm) => `${pad(Math.floor(hhmm / 100))}:${pad(hhmm % 100)}`;
const toHHMM = (str) => {
  const [h, m] = String(str).split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 100 + m;
};

export default function NotificationSettings({ settings, onChange }) {
  const [open, setOpen] = useState(false);
  const s = { ...DEFAULTS, ...settings };

  const update = (patch) => onChange({ ...s, ...patch });

  return (
    <div className="ntf-wrap">
      <button
        type="button"
        className="ntf-gear"
        aria-label="通知設定"
        aria-expanded={open}
        title="通知設定"
        onClick={() => setOpen((v) => !v)}
      >
        ⚙️
      </button>

      {open && createPortal(
        <div className="ntf-panel" role="dialog" aria-label="推播通知設定">
          <div className="ntf-panel-header">
            <span>🔔 推播通知</span>
            <button
              type="button"
              className="ntf-close"
              aria-label="關閉"
              onClick={() => setOpen(false)}
            >
              ✕
            </button>
          </div>

          <label className="ntf-row ntf-toggle-row">
            <input
              type="checkbox"
              className="ntf-toggle"
              checked={s.enabled}
              onChange={(e) => update({ enabled: e.target.checked })}
            />
            <span>啟用推播</span>
          </label>

          <label className="ntf-row">
            <span>車輛少於</span>
            <input
              type="number"
              className="ntf-threshold"
              min="0"
              max="50"
              value={s.threshold}
              onChange={(e) =>
                update({ threshold: Math.max(0, Math.floor(Number(e.target.value) || 0)) })
              }
            />
            <span>台時通知</span>
          </label>

          <div className="ntf-row">
            <span>生效時間</span>
            <input
              type="time"
              className="ntf-time"
              value={toTimeStr(s.activeFrom)}
              onChange={(e) => {
                const v = toHHMM(e.target.value);
                if (v !== null) update({ activeFrom: v });
              }}
            />
            <span>~</span>
            <input
              type="time"
              className="ntf-time"
              value={toTimeStr(s.activeTo)}
              onChange={(e) => {
                const v = toHHMM(e.target.value);
                if (v !== null) update({ activeTo: v });
              }}
            />
          </div>
        </div>, document.body
      )}
    </div>
  );
}
