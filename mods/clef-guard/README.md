# clef-guard

讓 Cloudflare 的決策模型 [Clef](https://blog.cloudflare.com/clef-decision-models/) 在每條 Bash 指令執行前判斷風險。Clef 認為指令可能難以復原或具破壞性時，即使這條指令原本會直接放行，也會先跳出確認視窗問你。

這是「System One」的用法：Clef 是快思考，只負責一個有限答案的判斷，幾百毫秒內給出機率；Claude 是慢思考，負責推理和動手。

```
Clef ⚠ 風險 87% · 破壞性 · 214ms
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
| `model` | `clef` | `clef`（27B，較準）或 `clef-flash`（9B，較快、較便宜） |
| `threshold` | `0.5` | Clef 判斷「難以復原或破壞性」的機率達到這個值（0 到 1）就先問你 |

**不要把 Token 寫進任何會 commit 的檔案**（包括專案的 `.claude/settings.json`）。用安裝時的設定畫面，或在自己的 shell 設定環境變數。

### 該選哪個模型

依 Cloudflare 公布的數據，`clef` 的延遲中位數約 209 ms、價格 $0.24 / 百萬輸入 token；`clef-flash` 約 39 ms、$0.09。一次判斷約送出 300 到 500 個 token，每天 1,000 條指令用 `clef` 大約 $0.10。Claude 每一輪本來就要好幾秒，多出的延遲幾乎感覺不到，而安全判斷寧可準一點，所以預設用 `clef`。

## 運作方式

- 只檢查 **Bash** 指令。Claude Code 照自己的規則（allow / deny 清單、權限模式）先決定，這個 mod 再看 Clef 的判斷：
  - 原本會**直接放行**、而 Clef 判斷有風險 → 改成**先問你**，確認視窗會寫出 Clef 給的機率。
  - 原本就會**問你** → 有風險時把 Clef 的判斷寫進確認視窗。
  - 原本就**擋下** → 不變，也不呼叫 Clef。
- 這個 mod **只會讓權限變嚴，不會放寬**。
- Clef 依五個等級打分：無害、專案內修改、對外變更、難以復原、破壞性。「難以復原」和「破壞性」的機率加總就是狀態列顯示的風險。
- 狀態列會顯示最近一次的判斷、最可能的等級和花費的時間。

### 送出去的資料

- 每條 Bash 指令都會送到 Cloudflare Workers AI。Cloudflare 聲明不讀取、不儲存、不用於訓練，但送出前請確認符合你的資安要求。
- 送出前會先遮掉看起來像密碼的內容：`Authorization` / `Bearer` 標頭、名稱含 `TOKEN`、`SECRET`、`PASSWORD`、`API_KEY` 的變數、`--password` 這類參數、網址裡的帳密、常見的金鑰格式（`sk-`、`ghp_`、`AKIA` 等）、私鑰，以及 40 字元以上英數混合的字串。這是經驗規則，不保證抓到所有密碼。
- 只送指令本身。Claude 為指令寫的說明不會送出，避免說明文字影響判斷。

## 限制

- **它不是安全閘門。** Clef 是機率模型，會判錯。請照常使用 Claude Code 的 allow / deny 規則，這個 mod 只是多一層提醒。
- Clef 出錯、逾時（超過 2 秒）或沒有設定 Token 時，指令照 Claude Code 原本的規則處理，狀態列會顯示「Clef 未判斷」和原因。
- 每條需要判斷的 Bash 指令都會多等一次 Clef 的回應。
- 在 auto 等權限模式下，「先問你」會交給該模式自己的決策者（例如 auto 模式的分類器），不一定會跳出視窗。
