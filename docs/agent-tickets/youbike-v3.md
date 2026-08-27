# YouBike v3 — 大版本迭代

Status: verified
Risk: medium(多模組、跨檔案,但皆為前端/唯讀 API)
Mode: branched

## v3.1 追加(grilling 決議 2026-08-26)

背景:列表原為「全域排序取前 300」,點地圖上排名 300 後的站無法 focus 到卡片。

已確認決議:
1. 列表改為「地圖可見範圍內的站」優先;範圍內 ≤300 全列,>300 時**排除被聚合的站**(以 markercluster __parent 判斷)再排序取 300
2. 有搜尋關鍵字時自動停用範圍過濾(Q1);moveend/zoomend + 150ms 緩衝刷新(Q2);收藏置頂→可借降序(Q3);定位模式優先、不套範圍(Q4)
3. 範圍過濾提供開關「只看此地圖範圍」toggle,預設開(Q6)
4. 選中站不在列表時自動清過濾(已實作)+ 選中站永遠保留在列表頂部
5. 新功能:a. URL 同步地圖視野 b. header 範圍統計列(X 站/Y 輛/Z 無車)f. 範圍內低車量徽章可點擊過濾 c. 📍 二次點擊回到定位處


## Goal
24+ 項已確認功能一次到位(見下方 Acceptance Criteria)。

## Coordinator Brief
- 分工:主 agent 負責共用檔案(app/page.jsx、app/api/stations/route.js、components/MapView.jsx、app/globals.css);
  獨立模組派 subagent:① PWA(manifest/sw/icon)② Overpass 地標(/api/landmarks + 元件)③ 通知模組(lib/notifications.js)。
- 資料源:臺北 tcgbusfs blob / 新北 data.ntpc.gov.tw(分頁 size=1000)/ 高雄 openapi.kcg.gov.tw b4dd9c40。
- 已確認決策:地圖永遠亮色圖磚但改用 OSM standard(道路分級);數字氣泡只渲染可見範圍;
  引入 react-leaflet-markercluster;通知時段可自訂;門檻全域可調;追蹤存本機 localStorage。

## Acceptance Criteria
- [x] API 回傳含 act 狀態與英文站名(snaen/snaen 欄位)
- [x] 手動刷新按鈕 + 上次更新時間顯示
- [x] 地圖數字氣泡(顏色=充足度、0車紅色「0」、暫停灰)僅渲染 bounds 內站點
- [x] markercluster 聚合
- [x] 點地圖 popup → 左列表捲動至該卡並高亮
- [x] 搜尋區名 → 地圖 flyTo 區域中心(內建行政區中心字典)
- [x] 定位:距離排序 + 卡片顯示公尺 + 「您在這裡」藍點 + 可見範圍過濾(max 10km)
- [x] 卡片顯示近 2 小時最高/最低
- [x] 曲線圖雙線(可借+可還)+ hover tooltip + 30m/1h/2h 視窗切換
- [x] localStorage 容量守衛(>4MB 自動清理最舊)
- [x] 低車量 Notification 推播 + 自訂時段 + 全域門檻設定 UI
- [x] 收藏匯出/匯入 JSON
- [x] URL ?station=id 分享連結
- [x] PWA:manifest + sw + emoji 圖示,可加入手機主畫面
- [x] 英文站名搜尋
- [x] 鍵盤:/ 搜尋、Esc 清除、↑↓ 選站、Enter 展開曲線
- [x] 地標圖層:Overpass 動態查詢(捷運/車站/公園/夜市百貨),固定顯示隨縮放調整

## Resume Point
- Next graph node: 主 agent 實作核心共用檔案;subagents 平行做獨立模組
- Verification: curl /api/stations(三市筆數)、瀏覽器實測各功能
