# image-preview

貼圖片到 Claude Code 的輸入框後，在輸入框上方顯示縮圖預覽，讓你在送出前確認貼上的是不是正確的圖片。

> [!IMPORTANT]
> **目前只支援特定終端機。** 只有支援 kitty graphics protocol 的終端機能顯示圖片，目前確認可用的是 **Ghostty** 和 **kitty**。
> 在 iTerm2、WezTerm、Windows Terminal、VS Code 內建終端機、Claude 桌面 app 等其他環境，只會顯示 `[Image #N] 寬×高` 這類文字，不會顯示圖片。
> 透過 ssh 連到遠端機器時也無法顯示，因為圖片檔在遠端，本機終端機讀不到。

## 安裝

在終端機的 Claude Code 中輸入：

```
/plugin install image-preview --marketplace williamchen0606/claude-mods
```

## 使用方式

照平常的方式貼上圖片（`Ctrl+V`）或拖曳圖檔到輸入框。輸入框出現 `[Image #N]` 後，上方就會顯示對應的縮圖：

- 一次貼多張圖時，縮圖會依序並排。
- 從輸入框刪掉 `[Image #N]`，對應的縮圖也會一起移除。
- 送出訊息後，預覽會自動清空。

## 標註圖片（僅 macOS）

貼上圖片後，會自動跳出一個浮動的標註視窗：

| 工具 | 快捷鍵 | 用法 |
| --- | --- | --- |
| 矩形 | `R` | 拖曳畫框 |
| 箭頭 | `A` | 從起點拖到箭頭指的地方 |
| 文字 | `T` | 點一下開始輸入，`Enter` 完成、`Esc` 取消 |
| 馬賽克 | `M` | 拖曳框出要遮住的範圍 |
| 編號 | `N` | 點一下放一個編號圓點，依序 1、2、3… |

- 顏色：工具列的色點，或按 `1`～`5`（紅、黃、綠、藍、黑）。
- `⌘Z` 或「復原」取消上一筆。
- 按「完成」（`Enter`）：輸入框裡的 `[Image #N]` 會被換成標註後的圖片，位置不變（編號會變成新的）。
- 按「略過」（`Esc`）或關掉視窗：保留原圖，什麼都不改。
- 視窗可以拉大縮小，下次會用上次的大小開啟。
- 想再標註一次，點縮圖本身，或點縮圖下方的 `[Image #N] 寬×高 ✎ 標註`。

注意事項：

- 第一次使用時會用 `swiftc` 編譯標註工具，需要先安裝 Xcode Command Line Tools（`xcode-select --install`）。編譯結果放在 `~/Library/Caches/claude-image-preview/`，視窗大小記在 `~/Library/Application Support/claude-image-preview/window.json`。
- 自動把標註圖貼回輸入框，是模擬按下 `Ctrl+V`，需要在「系統設定 → 隱私權與安全性 → 輔助使用」允許你的終端機（例如 Ghostty）。沒有權限時，標註圖會留在剪貼簿，提示會說明原因，自己按 `Ctrl+V` 貼上即可。
- 自動貼回成功後，剪貼簿會還原成原本的內容；如果這段時間你又複製了別的東西，就不會還原。
- 貼回的過程中（不到一秒），`[Image #N]` 後面的文字會暫時消失，貼好後會放回來。
- 不想貼上就自動開啟，可以在 `/plugin` 的設定中關掉 `autoAnnotate`，之後只能點縮圖或標籤開啟。

## 運作原理

Claude Code 在你貼上圖片的當下，就會把圖片存成檔案，位置在暫存資料夾的 `claude-<uid>/<專案>/<session id>/images/<N>.<副檔名>`。這個 mod 讀的就是那個檔案，所以預覽一定是你實際貼上的那張圖。

1. 貼圖不會觸發 mod 能接收的輸入事件，所以 mod 每 0.4 秒讀一次輸入框的內容，找出新增或被刪掉的 `[Image #N]`。
2. 找到新的標記時，從上述位置找出對應的圖片檔。PNG 直接交給終端機顯示；其他格式會先轉成 PNG，存在 `$TMPDIR/claude-image-preview/`。
3. 轉檔產生的 PNG 會在標記被刪掉或送出後清掉，殘留超過一天的也會自動清除。Claude Code 自己存的原始檔，mod 一律不會動。

## 需要的工具

貼上的圖片通常就是 PNG，不需要額外工具。只有 JPEG 等其他格式需要轉檔：

| 系統 | 轉換非 PNG 圖片 |
| --- | --- |
| macOS | 內建的 `sips` |
| Linux | ImageMagick（`magick` 或 `convert`） |

找不到圖片或缺少工具時，預覽位置會顯示原因，不會影響貼圖或送出。
