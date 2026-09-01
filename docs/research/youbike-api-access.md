# YouBike 官方資料 API 存取研究

研究日期：2026-09-01（Asia/Taipei）。本文件只採用三市政府資料平台、中央政府資料開放平臺、官方 API 文件與對官方端點的匿名 GET 檢查；不把第三方教學或聚合站作為依據。

## 專案目前使用的來源

[`app/api/stations/route.js`](../../app/api/stations/route.js) 將三個上游統一成自己的 `GET /api/stations` 回應，並在伺服器端快取 45 秒。實際上游如下：

| 城市 | 目前正式來源 | 平台／提供機關 | 備援 |
| --- | --- | --- | --- |
| 臺北 | [`youbike_immediate.json`](https://tcgbusfs.blob.core.windows.net/dotapp/youbike/v2/youbike_immediate.json) | [臺北市資料大平臺；交通局](https://data.taipei/dataset/detail?id=c6bc8aed-557d-41d5-bfb1-8da24f78f2fb) | 無 |
| 新北 | [`/api/datasets/010e5b15-3823-4b20-b401-b1cf000550c5/json`](https://data.ntpc.gov.tw/api/datasets/010e5b15-3823-4b20-b401-b1cf000550c5/json)（程式使用 `size=1000&page=n` 分頁） | [新北市資料開放平臺；交通局](https://data.ntpc.gov.tw/datasets/010E5B15-3823-4B20-B401-B1CF000550C5) | 無 |
| 高雄 | [`api.kcg.gov.tw` service](https://api.kcg.gov.tw/api/service/Get/b4dd9c40-9027-4125-8666-06bef1756092) | [高雄市政府交通局資料集](https://data.gov.tw/dataset/173477) | [`openapi.kcg.gov.tw` 舊網域](https://openapi.kcg.gov.tw/Api/Service/Get/b4dd9c40-9027-4125-8666-06bef1756092) |

新北的端點格式與可用 `json`、`csv`、`xml` 格式由其[官方開發指引](https://data.ntpc.gov.tw/applications)說明；高雄中央平台資料集連回的[高雄市資料集頁](https://data.kcg.gov.tw/DataSet/Detail/f4a70266-cfb6-42f9-87fa-6ed4606f4fea)是該 service 的市府來源。

## 存取、授權與更新

| 城市 | API key／費用 | 資料授權 | 發布更新頻率 | 可用性與公平使用結論 |
| --- | --- | --- | --- | --- |
| 臺北 | 不需要 API key。2026-09-01 對正式 URL 的未帶認證 GET 回 `200 application/json`；資料集標示免費。 | 資料集標示「公開」並連至[政府資料開放授權條款第 1 版](https://data.gov.tw/license)。 | [資料集](https://data.taipei/dataset/detail?id=c6bc8aed-557d-41d5-bfb1-8da24f78f2fb)標示每 1 分鐘。 | 已查的官方資料頁與端點回應沒有公布數值速率上限、配額或 SLA；不能據此推論無限制。以快取／共享一次上游請求服務所有使用者，且不要高於來源更新節奏輪詢。 |
| 新北 | 不需要 API key。匿名 GET 回 `200 application/json`；資料集無收費欄位且以政府 OpenAPI 提供。 | [資料集](https://data.ntpc.gov.tw/datasets/010E5B15-3823-4B20-B401-B1CF000550C5)明示政府資料開放授權條款第 1 版。 | 同一資料集標示每 5 分鐘。 | 官方資料集／[開發指引](https://data.ntpc.gov.tw/applications)未公布數值速率上限、配額或 SLA。應依 5 分鐘更新與快取設計，而非讓每個客戶端輪詢。 |
| 高雄 | 不需要 API key。匿名 GET 主端點回 `200 application/json`；官方資料集標示免費。 | [中央政府資料集](https://data.gov.tw/dataset/173477)明示政府資料開放授權條款第 1 版。 | **官方資訊不一致：**資料集描述說資料每 10 分鐘更新一次，但同頁的「更新頻率」欄位是「不定期更新」。 | 官方資料集與 service 文件未公布數值速率上限、配額或 SLA。將資料視為可能逾時、改版或暫停的外部依賴；保留現有備援與失敗時的城市快取。 |

「無 API key」是目前端點與官方文件的實測／文件結論，並非長期介面承諾；若市府未來改為要求驗證，應改由 server-side secret 管理，不能將 key 放進瀏覽器。

三市明示採用的[政府資料開放授權條款第 1 版](https://data.gov.tw/license)允許不限目的、時間、地域且免授權金利用及製作衍生物，但要求以顯名聲明標示原資料提供機關。產品頁面／資料說明至少應標註例如「資料來源：臺北市政府交通局、新北市政府交通局、高雄市政府交通局；依政府資料開放授權條款第 1 版」；授權不及於商標權，也不構成資料正確或持續可用的保證。

## CORS 與部署風險

以下為 2026-09-01 對正式 URL 的 GET response header 檢查；header 是當下行為，並不是來源的永久契約。

| 城市 | 觀察到的 CORS | 前端直連判斷 | 專案部署建議 |
| --- | --- | --- | --- |
| 臺北 | `Access-Control-Allow-Origin: *` | 技術上可跨站讀取。 | 仍優先走 `/api/stations`，讓三市有一致快取、timeout、錯誤與欄位格式。 |
| 新北 | `Access-Control-Allow-Origin: https://data.ntpc.gov.tw` | 其他網域的瀏覽器請求會因 CORS 被阻擋。 | 必須經由同源 Next.js route／受控後端代理；不可把資料 URL 直接交給部署後的瀏覽器。 |
| 高雄 | 主端點和舊網域的回應未見 `Access-Control-Allow-Origin`。 | 應視為不能安全地依賴跨站瀏覽器讀取。 | 必須走 server-side route；保留主端點優先、舊網域備援與 timeout。 |

因此目前 route 的 server-side fetch 與 45 秒快取同時解決新北／高雄 CORS 風險，並降低無公開配額時的上游壓力。部署平台若將 route 改成靜態輸出、edge 限制外連，或在每個請求啟動新 instance，則快取可能失效或變成 per-instance；應在部署環境改用共享快取／CDN，並保留「最後成功資料」的失敗降級。

授權條款也明定在正當事由下資料提供機關可停止全部或一部資料提供，且不負賠償或補償責任；這是可用性設計要有 timeout、`Promise.allSettled`、城市別錯誤與陳舊快取的官方依據，而不是把資料集當作 SLA 服務。

## 回應結構與欄位差異

三者都提供站點識別、名稱、行政區、地址、營運狀態、可借／可還、座標與更新時間；名稱相近不代表 schema 相同。下表以官方資料集的欄位說明和 2026-09-01 的正式 API 回應各取一筆交叉確認。

| 面向 | 臺北 | 新北 | 高雄 |
| --- | --- | --- | --- |
| 根節點／站點列 | JSON 陣列 | JSON 陣列（可分頁） | envelope 的 `data.data.retVal`（adapter 的遞迴 `rowsFrom` 同時容忍其他包裝） |
| 總車位 | `Quantity`（大寫 Q） | `tot_quantity` | `tot` |
| 可借 | `available_rent_bikes` | `sbi_quantity` | `sbi` |
| 可還 | `available_return_bikes` | `bemp` | `bemp` |
| 座標 | `latitude`、`longitude` | `lat`、`lng` | `lat`、`lng` |
| 車種明細 | 沒有 YB2／電輔拆分欄位 | `yb2_quantity`、`eyb_quantity` | `sbi_detail.yb2`、`sbi_detail.eyb` |
| 其他時間欄位 | 除 `mday` 外還有 `srcUpdateTime`、`updateTime`、`infoTime`、`infoDate` | `mday` | `mday` |

臺北官方欄位表見[資料集說明](https://data.taipei/dataset/detail?id=c6bc8aed-557d-41d5-bfb1-8da24f78f2fb)，新北見[資料集欄位](https://data.ntpc.gov.tw/datasets/010E5B15-3823-4B20-B401-B1CF000550C5)，高雄見[中央平台資料集欄位](https://data.gov.tw/dataset/173477)。因此不應把其中一市的 raw row 直接當成其他兩市的型別；維持目前 `normTp`、`normNtpc`、`normKcg` 的 city-specific adapter，並把空字串視為未知值而非自動轉成 `0`。

## 維運決策

1. 繼續只向本專案 `/api/stations` 讀取，不在 client bundle 暴露三個上游 URL 作為主要資料路徑。
2. 快取時間可比臺北 1 分鐘更短，但不應把它當輪詢上限；目前 45 秒能合併流量並仍保留近即時體驗。若降低至極短 TTL，應先取得市府明確配額／公平使用政策。
3. 顯示 `fetchedAt` 與各站 `updated` 時間，特別是高雄；不要將資料集頻率寫成對使用者的即時保證。
4. 對 schema 漂移、零站點回應、上游 timeout 和 CORS／網域異動持續監測；成功回應不代表三個城市皆有資料，應保留城市別錯誤和前次快取降級。

## 一手來源索引

- [臺北市資料大平臺：YouBike2.0 臺北市公共自行車即時資訊](https://data.taipei/dataset/detail?id=c6bc8aed-557d-41d5-bfb1-8da24f78f2fb)
- [新北市資料開放平臺：新北市公共自行車租賃系統（YouBike2.0）](https://data.ntpc.gov.tw/datasets/010E5B15-3823-4B20-B401-B1CF000550C5)
- [新北市資料開放平臺：開發指引](https://data.ntpc.gov.tw/applications)
- [中央政府資料開放平臺：高雄 YouBike2.0 公共自行車租賃站即時資訊](https://data.gov.tw/dataset/173477)
- [高雄市資料平台：資料集頁](https://data.kcg.gov.tw/DataSet/Detail/f4a70266-cfb6-42f9-87fa-6ed4606f4fea)
- [政府資料開放授權條款第 1 版](https://data.gov.tw/license)
