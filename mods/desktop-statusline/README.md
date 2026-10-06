# desktop-statusline

給 Claude **桌面 app** 用的狀態列，顯示在輸入框上方：

```
5h 34% · 2h10m 後重置 · 約 1h20m 後用完 │ 7d 12% · 3d4h 後重置 │ Context 42% / 200k │ $1.23
```

終端機版已經有好用的 statusline 工具，所以這個 mod 預設只在桌面 app 顯示。想在終端機也顯示，可以在設定裡打開（見下方）。

## 安裝

在終端機的 Claude Code 中輸入：

```
/plugin install desktop-statusline --marketplace williamchen0606/claude-mods
```

選擇 **user** scope 安裝後，桌面 app 的 Code 分頁也會載入這個 mod。

## 顯示內容

| 欄位 | 說明 |
| --- | --- |
| `5h 34%` | 5 小時用量窗口已用的百分比，接著是距離重置的時間 |
| `約 1h20m 後用完` / `可撐到重置` | 依目前的消耗速度估算，5 小時額度會在重置前用完，還是撐得到重置 |
| `7d 12%` | 7 天（每週）用量已用的百分比，接著是距離重置的時間 |
| `Context 42% / 200k` | 目前對話佔 context window 的比例，以及 window 大小 |
| `$1.23` | 這個 session 到目前為止的花費，和 `/cost` 相同。訂閱方案下是依 API 價格換算的估計值 |

用量超過 70% 會顯示黃色，超過 90% 會顯示紅色。

- 5 小時和 7 天的用量只有訂閱方案（Pro / Max）才有。使用 API key 時不會顯示這兩欄。
- 第一次收到回應之前，Context 會顯示 `–`。

### 「還能撐多久」怎麼算

1. 這個 mod 會記錄 5 小時窗口的用量變化。紀錄存在 mod 自己的 store，跨 session 共用，因為 5 小時窗口是整個帳號共用的。
2. 最近 30 分鐘內有至少 5 分鐘的紀錄時，用這段期間的消耗速度估算；紀錄不足時，改用這個窗口從開始到現在的平均速度。
3. 把估算的用完時間和重置時間比較：會先用完就顯示「約 X 後用完」，否則顯示「可撐到重置」。剛開新窗口、資料還不夠時，不會顯示這一項。

## 更新時機

- 每輪對話結束後，以及 5 小時或 7 天用量每變動 1% 時，Claude Code 會主動通知 mod 更新。
- 另外每 30 秒更新一次，讓倒數時間保持正確。

## 設定

| 選項 | 預設 | 說明 |
| --- | --- | --- |
| `showInTerminal` | `false` | 也在終端機的輸入框上方顯示 |

可以在 `/plugin` 的設定畫面切換，或寫進 `~/.claude/settings.json`：

```json
{ "pluginConfigs": { "desktop-statusline": { "options": { "showInTerminal": true } } } }
```
