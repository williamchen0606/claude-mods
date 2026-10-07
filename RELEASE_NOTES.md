# Release Notes

這份文件記錄 claude-mods 每次發布的變更。每個 mod 各自有版本號（在 `mods/<mod-name>/.claude-plugin/plugin.json` 的 `version`），所以每筆紀錄都會寫成 `<mod-name> <版本>`；不屬於任何 mod 的變更（marketplace、文件、授權等）歸在「Repo」底下。

最新的變更寫在最上面。還沒發布的變更先放在「未發布」區塊，發布時再改成日期。

## 未發布

### image-preview 0.3.0

- 新增圖片標註（僅 macOS，最小版本）：貼上圖片後會自動開啟浮動的標註視窗，可以畫矩形和箭頭、復原。
  - 按「完成」（Enter）後，輸入框裡原本的 `[Image #N]` 會換成標註後的圖片；按「略過」（Esc）或關掉視窗則保留原圖。
  - 點縮圖下方的 `[Image #N] 寬×高 ✎ 標註` 可以再開一次標註視窗。
  - 自動貼回需要給終端機「輔助使用」權限；沒有權限時，標註圖會放在剪貼簿，按 `Ctrl+V` 貼上即可。
  - 第一次使用時會用 `swiftc` 編譯標註工具，需要 Xcode Command Line Tools。
- 新增 `autoAnnotate` 選項（預設開啟）：關掉後貼上圖片不會自動開啟標註視窗，只能點標籤開啟。

## 2026-10-07

### Repo

- 新增 MIT License，準備公開 repo。
- 在專案設定（`.claude/settings.json`）中把這個 repo 註冊成 `claude-mods` marketplace，並啟用 desktop-statusline，讓 clone 這個 repo 的雲端 session 也會載入它。

### desktop-statusline 0.1.0（新 mod）

- 在 Claude 桌面 app 的輸入框上方顯示一條狀態列：
  - 5 小時與 7 天用量上限，以及各自的重置倒數。
  - 預估 5 小時額度會不會在重置前用完（用量速度取自存在 `$.store` 的取樣）。
  - context window 使用率。
  - 這個 session 的花費。
- 數據來自 `$.session.usage()` 和 `session.measure` 事件。
- 預設不在終端機顯示，開啟 `showInTerminal` 選項後也會顯示。

### image-preview 0.2.2

- 改成把自己的預覽畫在其他 mod 的內容下方，而不是取代它們，所以可以和 desktop-statusline 同時顯示。

## 2026-10-06

### image-preview 0.2.1

- 修正偶爾顯示「讀取失敗（exit 0）」的問題：之前可能在 Claude Code 還沒寫完圖片檔時就去讀取。現在會等 PNG 的 IEND chunk 出現（其他格式則等檔案大小穩定）才讀取，讀不到大小時以 exit 17 回報，查詢最多重試 5 次，仍失敗時會顯示並寫入 debug log 腳本的輸出。

### image-preview 0.2.0

- 改為讀取 Claude Code 自己在貼上時存下的圖片檔（`<temp>/claude-<uid>/<project>/<sessionId>/images/<N>.<ext>`），不再讀剪貼簿，所以預覽一定是實際貼上的那張圖。
- 貼上圖片不會觸發 `prompt.edit`，改用每 400ms 輪詢 `$.prompt.read()` 偵測 `[Image #N]` 佔位符。
- 多張圖片並排顯示；刪掉佔位符時對應的預覽也會移除；不會刪除 Claude Code 自己的檔案。

### image-preview 0.1.0（新 mod）

- 輸入框中每出現一個 `[Image #N]`，就在上方顯示該圖片的縮圖。
- 圖片只在 Ghostty / kitty 終端機顯示，其他介面改顯示一行文字。

### Repo

- 建立 mods marketplace：新增 `.claude-plugin/marketplace.json`、README、`AGENTS.md` 和 `CLAUDE.md`。
- 引擎產生的型別檔（`mods/*/.claude-plugin/types/`）加入 gitignore。
