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

## 運作原理與限制

Claude Code 不會把輸入框裡圖片的內容提供給 mod，所以這個 mod 是用「同時間的剪貼簿」來推斷你貼了哪張圖：

1. 監看輸入框的每次編輯。只要出現新的 `[Image #N]`，就馬上讀取一次系統剪貼簿裡的圖片。
2. 如果那次編輯貼上的是一個圖檔路徑（拖曳檔案進終端機時就是這種情況），就改為直接讀取那個檔案。
3. 讀到的圖片先存成 PNG，放在 `$TMPDIR/claude-image-preview/`，再交給終端機顯示。

因此有幾個已知限制：

- 預覽顯示的是**偵測到貼上當下剪貼簿裡的圖**。如果貼上後剪貼簿馬上被其他內容蓋掉，預覽就可能和實際貼上的圖不一致。
- 預覽可能要等你在輸入框再按一個鍵才出現，因為 Claude Code 插入 `[Image #N]` 時，不一定會通知 mod。
- 暫存的 PNG 會在送出或刪除後清掉，殘留的檔案超過一天也會自動清除。

## 需要的工具

| 系統 | 讀取剪貼簿 | 轉換非 PNG 的拖曳檔案 |
| --- | --- | --- |
| macOS | 內建的 `osascript`；有裝 [`pngpaste`](https://github.com/jcsalterego/pngpaste) 會優先使用 | 內建的 `sips` |
| Linux（Wayland） | `wl-paste`（套件名稱 `wl-clipboard`） | ImageMagick（`magick` 或 `convert`） |
| Linux（X11） | `xclip` | ImageMagick（`magick` 或 `convert`） |

缺少工具時，預覽位置會顯示原因，不會影響貼圖或送出。
