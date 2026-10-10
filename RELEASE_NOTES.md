# Release Notes

這份文件記錄 claude-mods 每次發布的變更。每個 mod 各自有版本號（在 `mods/<mod-name>/.claude-plugin/plugin.json` 的 `version`），所以每筆紀錄都會寫成 `<mod-name> <版本>`；不屬於任何 mod 的變更（marketplace、文件、授權等）歸在「Repo」底下。

最新的變更寫在最上面。還沒發布的變更先放在「未發布」區塊，發布時再改成日期。

## 未發布

### clef-guard 0.4.0

- 除了 Bash，也會檢查**寫入檔案（Write）、修改檔案（Edit）和讀取網址（WebFetch）**。可以用新設定 `tools` 選擇要檢查哪些工具。
- 每次判斷改成一次問 Clef 四個問題：風險等級、**風險類型**（刪除資料、改寫 git 歷史、改系統設定、執行下載的程式、外送資料、專案外變更）、**是否唯讀**，以及**是否符合你最近的要求**。對話框和狀態列會顯示風險類型，看得出為什麼被攔下。
- 新增「跟要求無關」的判斷：會把你最近三則訊息（遮掉密碼後）一起送給 Clef。Clef 有八成以上把握某個動作跟你的要求無關，而且會動到專案以外時，會先問你。不想送出訊息可以關掉新設定 `sendRequests`。
- 新增**一定要問的操作**：`rm -r` / `rm -rf`、刪除 git repo（`rm` 的對象是 `.git`、`gh repo delete`）、`git push --force` 和刪除遠端分支、抹除磁碟。這些由 clef-guard 在本機判斷，不管 Clef 怎麼說、有沒有設定 Token，都一定會問你。可以用新設定 `alwaysAsk` 再加上自己的指令，例如 `terraform destroy`。
- 新設定 `autoApprove`（預設關閉）：Claude Code 原本要跳權限視窗、而 Clef 有 95% 以上把握是唯讀又符合你的要求時，直接放行。一定要問的操作和 deny 規則不受影響。
- Claude Code 原本就放行的單純讀取指令（`ls`、`cat`、`git status` 等）不再送給 Clef，省下延遲和費用。
- 狀態列開頭會顯示工具名稱，例如 `Bash · Clef 風險 90% · 破壞性 · 刪除資料 · 214ms`。

### desktop-statusline 0.4.0

- 「已用 / 剩餘」、進度條或百分比、進度條寬度，從 `/config` 移到桌面 app 的設定畫面（第一層的「顯示方式」）。`/config` 只有終端機讀得到，所以之前在桌面 app 裡改不到。舊的設定值不會轉移，請在設定畫面重新選一次。
- 狀態列在還沒有用量資料時也會顯示（「狀態列：等待用量資料 ⚙」），剛安裝時就能從 `⚙` 打開設定畫面；就算把所有欄位都移除，`⚙` 也會留著。
- README 說明修正：版面是桌面 app 的所有 session 共用，和終端機分開。

### desktop-statusline 0.3.3

- 重新套用 0.3.1：終端機（TUI）不顯示 `/desktop-statusline`，直接輸入也不會開啟設定畫面。0.3.2 的撤回是誤會，桌面 app 一直都能正常使用。

### desktop-statusline 0.3.2

- 暫時撤回 0.3.1 的變更（後來確認是誤會，已在 0.3.3 恢復）。

### desktop-statusline 0.3.1

- 終端機（TUI）不再受影響：沒打開 `showInTerminal` 時，`/desktop-statusline` 不會出現在終端機的指令選單，直接輸入也只會顯示一行說明，不會開啟設定畫面。桌面 app 照常使用。

### desktop-statusline 0.3.0

- 新增設定畫面：輸入 `/desktop-statusline` 或點狀態列上的 `⚙` 打開，附即時預覽。
  - 分兩層：先選要編輯哪一行，再調整這一行的欄位（往前、往後、移到上一行或下一行、移除）。
  - 新增欄位改成從清單選，只列出還沒放上去的欄位，不會打錯字或重複。
  - 狀態列可以排成多行（最多 4 行），行可以新增、刪除、調整順序，也可以恢復預設。
  - 版面存在 mod 的 store，所有 session 共用。
- 移除 0.2.0 的 `items` 文字設定，改用設定畫面。之前設定過 `items` 的話，請在設定畫面重新排一次。
- 同一類欄位相鄰時用 `·` 連接，不同類之間用 `│` 分隔，不用再自己分組。

### desktop-statusline 0.2.0

- 5 小時、7 天用量和 context 改用進度條顯示：平常是綠色，超過 70% 變黃色，超過 90% 變紅色。
- 新設定 `items`：自己決定要顯示哪些欄位（`5h`、`5h-reset`、`5h-estimate`、`7d`、`7d-reset`、`context`、`cost`）、順序和分組，例如 `5h, 5h-estimate | context`。寫錯的 id 會略過並提示。
- 新設定 `display`：百分比類欄位要顯示進度條、百分比文字，還是兩者都顯示（預設兩者）。
- 新設定 `percent`：改成顯示剩餘用量（`剩 66%`），進度條隨用量減少。
- 新設定 `barWidth`：進度條寬度（預設 10 格）。

### clef-guard 0.3.0

- 設定的模型新增 `clef-omni`：Cloudflare 新推出的多模態 Clef（$0.15 / 百萬輸入 token，純文字判斷中位數約 130 ms）。預設仍是 `clef`。
- README 更新各模型的價格和延遲：`clef-flash` 降價到 $0.038 / 百萬輸入 token，`clef` 的延遲快了 1.7 到 2 倍。

## 2026-10-08

### clef-guard 0.2.0

- Clef 判斷有風險時，改由 clef-guard **自己跳出問題問你**（「執行」/「不要執行」），不再交給權限模式決定。之前在 auto 模式下，「需要確認」會交給 auto 模式的分類器，有風險的指令可能沒問你就執行了。
- 只有選「執行」才會執行；選「不要執行」、關掉對話框或無法詢問時一律擋下。在「Type something」輸入的文字會轉告 Claude，讓它換個做法。
- 狀態列不再重複顯示 `⚠`，並加上你的決定（等你確認、你已確認、已拒絕）。

### clef-guard 0.1.0（新 mod）

- 每條 Bash 指令執行前，交給 Cloudflare 的決策模型 Clef 判斷風險（無害、專案內修改、對外變更、難以復原、破壞性）。
  - 原本會直接放行的指令，若 Clef 判斷「難以復原或破壞性」的機率達到門檻（預設 50%），改成先跳出確認視窗；原本就會問的指令，確認視窗會附上 Clef 的判斷。
  - 只會讓權限變嚴，不會放寬；原本就擋下的指令不會呼叫 Clef。
  - 狀態列顯示最近一次的風險機率、等級和花費的時間。
- 設定：Cloudflare Account ID、API Token（存在安全儲存區，也可以改用環境變數 `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`）、模型（`clef` 或 `clef-flash`，預設 `clef`）、門檻。
- 指令送出前會先遮掉看起來像密碼或金鑰的內容。
- Clef 出錯、逾時（2 秒）或沒有設定時，照 Claude Code 原本的規則處理。

### Repo

- AGENTS.md 新增「Git workflow」：變更完成且檢查通過後，由 Claude 直接開 PR 並 squash 合併回 `main`；合併後的修正一律開新 PR；不得 commit 任何 API token 或憑證。

## 2026-10-07

### image-preview 0.3.0

- 新增圖片標註（僅 macOS）：貼上圖片後會自動開啟標註視窗。
  - 工具：選取、矩形、橢圓、直線、箭頭、文字、馬賽克、螢光筆、畫筆、編號圓點；八種顏色、五段粗細（也決定文字大小，預設 24 pt），矩形、橢圓和文字可以切換外框或填滿。
  - 選取工具：點選標註後可以移動、拉控制點調整大小或端點，並修改它的顏色、粗細、填滿；雙擊文字可以重新編輯，`⌫` 刪除，方向鍵微調。剛畫好的標註會自動選取。
  - 可以復原、重做；按住 `Shift` 畫正方形、正圓或 45° 直線。
  - 標註可以畫到原圖外面，送出的圖片會自動放大包住所有標註，超出的部分是白底；視窗中原圖以外的區域以較深的灰色顯示。
  - 工具列放在視窗標題列上，用圖示分組，滑鼠移上去會顯示名稱和快捷鍵；顏色和粗細改成下拉選單；底部顯示操作提示和縮放比例。
  - 按「完成」（Enter）後，輸入框裡原本的 `[Image #N]` 會在原來的位置換成標註後的圖片；按「略過」或關掉視窗則保留原圖。
  - 點縮圖本身，或點縮圖下方的 `[Image #N] 寬×高 ✎ 標註`，可以再開一次標註視窗。
  - 視窗可以自由調整大小，並記住上次的大小。
  - 自動貼回需要給終端機「輔助使用」權限，貼回後會還原剪貼簿原本的內容；沒有權限或無法切回終端機時，標註圖會留在剪貼簿，提示會說明原因，按 `Ctrl+V` 貼上即可。
  - 第一次使用時會用 `swiftc` 編譯標註工具，需要 Xcode Command Line Tools。
- 新增 `autoAnnotate` 選項（預設開啟）：關掉後貼上圖片不會自動開啟標註視窗，只能點縮圖或標籤開啟。

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
