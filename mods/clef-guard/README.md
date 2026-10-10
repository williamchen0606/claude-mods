# clef-guard

讓 Cloudflare 的決策模型 [Clef](https://blog.cloudflare.com/clef-decision-models/) 在每條 Bash 指令執行前判斷風險。Clef 認為指令可能難以復原或具破壞性時，會先跳出問題問你，你選「執行」才會執行。default、auto 等各種權限模式都一樣。

這是「System One」的用法：Clef 是快思考，只負責一個有限答案的判斷，幾百毫秒內給出機率；Claude 是慢思考，負責推理和動手。

```
╭ clef-guard
│ Clef 判斷這條指令有 90% 的機率難以復原或具破壞性（最可能：破壞性）：
│
│ rm -rf ./build
│
│ 要執行嗎？
❯ 1. 執行
  2. 不要執行
```

狀態列會顯示最近一次的判斷：

```
⚠ clef-guard: Clef 風險 90% · 破壞性 · 214ms · 你已確認
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

**不要把 Token 寫進任何會 commit 的檔案**（包括專案的 `.claude/settings.json`）。用安裝時的設定畫面，或在自己的 shell 設定環境變數。

### 該選哪個模型

依 Cloudflare 公布的數據：

| 模型 | 價格（每百萬輸入 token） | 延遲 | 說明 |
| --- | --- | --- | --- |
| `clef` | $0.24 | 中位數約 100 到 120 ms（原本約 209 ms，Cloudflare 改善伺服後快了 1.7 到 2 倍） | 最準 |
| `clef-flash` | $0.038 | 約 39 ms | 最快、最便宜；託管版的上下文縮小到 24k，判斷一條指令綽綽有餘 |
| `clef-omni` | $0.15 | 純文字中位數約 130 ms | 新的多模態模型，以 Qwen3-Omni-30B-A3B 為基礎 |

一次判斷約送出 300 到 500 個 token，每天 1,000 條指令用 `clef` 大約 $0.10。Claude 每一輪本來就要好幾秒，多出的延遲幾乎感覺不到，而安全判斷寧可準一點，所以預設用 `clef`。clef-guard 只送出指令文字，用不到 `clef-omni` 的圖片、聲音和影片能力；想在價格和速度之間取個中間值時可以選它。

## 運作方式

- 只檢查 **Bash** 指令。Claude Code 照自己的規則（allow / deny 清單、權限模式）先決定，這個 mod 再看 Clef 的判斷：
  - Clef 判斷「難以復原」和「破壞性」的機率加總**達到門檻** → clef-guard **自己問你**，選「執行」才會執行，選「不要執行」就擋下。不管原本會直接放行、跳出權限視窗，還是交給 auto 模式的分類器，都改成問你。
  - 也可以在「Type something」輸入文字，例如「先備份再刪」。指令不會執行，你輸入的內容會轉告 Claude，讓它換個做法。
  - 對話框被關掉、沒有選「執行」，或在 `claude -p` 這類無法詢問的情況下，一律**不執行**。
  - 沒達到門檻 → 照 Claude Code 原本的規則處理，不會多問。
  - 原本就**擋下** → 不變，也不呼叫 Clef。
- Clef 依五個等級打分：無害、專案內修改、對外變更、難以復原、破壞性。
- 狀態列會顯示最近一次的風險、最可能的等級、花費的時間，以及你的決定（等你確認、你已確認、已拒絕）。

### 為什麼自己問，而不是交給權限視窗

如果只回答「需要確認」（`ask`），Claude Code 會交給目前權限模式的決策者處理。在 auto 模式下，決策者是一個分類器，不是你，結果有風險的指令可能沒問你就執行了。所以 clef-guard 在判斷有風險時會直接問你，確保在任何模式下都由你決定。

### 送出去的資料

- 每條 Bash 指令都會送到 Cloudflare Workers AI。Cloudflare 聲明不讀取、不儲存、不用於訓練，但送出前請確認符合你的資安要求。
- 送出前會先遮掉看起來像密碼的內容：`Authorization` / `Bearer` 標頭、名稱含 `TOKEN`、`SECRET`、`PASSWORD`、`API_KEY` 的變數、`--password` 這類參數、網址裡的帳密、常見的金鑰格式（`sk-`、`ghp_`、`AKIA` 等）、私鑰，以及 40 字元以上英數混合的字串。這是經驗規則，不保證抓到所有密碼。
- 只送指令本身。Claude 為指令寫的說明不會送出，避免說明文字影響判斷。

## 限制

- **它不是安全閘門。** Clef 是機率模型，會判錯。請照常使用 Claude Code 的 allow / deny 規則，這個 mod 只是多一層提醒。
- Clef 出錯、逾時（超過 2 秒）或沒有設定 Token 時，指令照 Claude Code 原本的規則處理，狀態列會顯示「Clef 未判斷」和原因。
- 每條需要判斷的 Bash 指令都會多等一次 Clef 的回應。實際延遲會比 Cloudflare 公布的數字多出你到 Cloudflare 的網路往返時間，大約 0.5 到 0.8 秒。
- 被 Clef 判斷有風險的指令，即使已經在 allow 清單裡，也會再問你一次。如果太常誤判，可以調高 `threshold`。
