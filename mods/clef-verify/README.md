# clef-verify

Claude 改了檔案、準備說「完成了」的時候，先讓 Cloudflare 的決策模型 [Clef](https://blog.cloudflare.com/clef-decision-models/) 檢查一次：該跑的測試有沒有跑、有沒有通過、回覆裡說的事有沒有依據、你要的東西有沒有做完。少了什麼，就把 Claude 退回去補，不會讓它直接結束。

判斷分成兩段，照 Cloudflare 對 System One 模型的分工：抽取模型 [Clairic](https://blog.cloudflare.com/clairic-extraction-model/) 先從測試和建置的輸出抽出事實（跑了哪些檢查、通過幾個、失敗幾個、哪些失敗），Clef 再拿這些事實加上整個回合的步驟做判斷。Clairic 只負責抽取，要不要退回一律由 Clef 決定。

常見的情況：Claude 改完程式說「修好了，測試通過」，但其實沒跑測試，或測試失敗了還是回報完成。

退回時，Claude 會讀到原因。Clef 判斷檢查沒通過時，會附上 Clairic 從輸出抽到的依據：

```
clef-verify：結束前請先處理：
· 改完之後跑的檢查沒有通過。請修正；如果失敗和這次修改無關，請說明原因。
  依據：「失敗 3 個」、「parser > handles empty input」、「npm test（結束時回報錯誤）」
如果確定不需要，請在回覆中說明原因再結束。
```

狀態列會顯示最近一次的檢查，包括 Clairic 從輸出讀到的測試數：

```
⚠ clef-verify: 需要檢查 95% · 測試 120 過 / 3 敗 · 檢查沒過 · 620ms · 退回 1/2
```

## 安裝

在終端機的 Claude Code 中輸入：

```
/plugin install clef-verify --marketplace williamchen0606/claude-mods
```

安裝時會要求填入 Cloudflare 的設定。Token 的準備方式和 [clef-guard](../clef-guard#準備-cloudflare-api-token) 一樣；兩個 mod 都會讀環境變數 `CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_API_TOKEN`，設一次環境變數就能共用。

## 設定

| 選項 | 預設 | 說明 |
| --- | --- | --- |
| `accountId` | （空） | Cloudflare Account ID；沒填時讀環境變數 `CLOUDFLARE_ACCOUNT_ID` |
| `apiToken` | （空） | Cloudflare API Token，存在系統的安全儲存區，不會寫進 settings.json；沒填時讀環境變數 `CLOUDFLARE_API_TOKEN` |
| `model` | `clef` | 做判斷的 Clef 模型：`clef`（最準）、`clef-flash`（最快、最便宜）或 `clef-omni` |
| `extractor` | `clairic` | `clairic`：Clef 判斷前，先由 Clairic 讀最後一次修改之後的指令輸出，抽出檢查指令、測試數和失敗項目交給 Clef，退回時附上依據。`off`：不用 Clairic，Clef 自己讀輸出的片段 |
| `threshold` | `0.7` | Clef 有多少把握（0 到 1）認為少了什麼，才把 Claude 退回 |
| `maxRetries` | `2` | 你的每一則訊息最多退回幾次。用完後就讓 Claude 結束，並跳出通知告訴你 Clef 還覺得少了什麼 |

**不要把 Token 寫進任何會 commit 的檔案**（包括專案的 `.claude/settings.json`）。

### 費用和延遲

依 Cloudflare 公布的價格（每百萬輸入 token）：

| 模型 | 價格 | 每次檢查約花 | 說明 |
| --- | --- | --- | --- |
| `clef` | $0.24 | $0.001 到 $0.0017 | 最準，預設 |
| `clef-flash` | $0.038 | 不到 $0.0003 | 最快、最便宜 |
| `clef-omni` | $0.15 | $0.0006 到 $0.001 | 多模態；clef-verify 只送文字 |
| `clairic`（抽取） | $0.10 | 最多約 $0.0005 | 只在最後一次修改之後有跑指令時呼叫 |

用 Clairic 時，兩個模型是先後呼叫的（Clef 要等 Clairic 的結果），每輪結束時大約多等 0.5 秒。Clairic 還在 Cloudflare 的預覽階段，API 可能會變；它出錯或超過 3 秒沒回應時，Clef 照樣判斷，只是少了 Clairic 的事實和依據，狀態列會顯示「Clairic 未抽取」。

## 運作方式

Claude 每次要結束回合時（Claude Code 的 Stop 事件）：

1. 這個回合（從你最後一則訊息開始）沒有用 Write、Edit 或 NotebookEdit 改過檔案 → 直接結束，不呼叫任何模型。
2. 有其他 hook 已經擋下結束，或還有背景工作在跑（Claude 只是在等它） → 不檢查。
3. **抽取（Clairic）**：最後一次修改之後有跑指令時，把那些指令和輸出的最後一段送給 Clairic，請它抽出：
   - 哪些指令是測試、建置、lint 或型別檢查。
   - 輸出回報的通過數和失敗數（每個總結各抽一個數字，由程式加總，不讓模型計算）。
   - 失敗的測試名稱或錯誤訊息。

   程式再找出 Clairic 認出的檢查指令裡，哪些結束時回報了錯誤。Clairic 把握不到一半的項目不採用。最後一次修改之後沒跑任何指令時，沒有東西可讀，不呼叫 Clairic。
4. **判斷（Clef）**：把你的要求、Claude 這個回合做的步驟（改了哪些檔案、跑了哪些指令、指令是否失敗、輸出的最後一段）、Claude 的最後回覆，以及 Clairic 抽出的事實送給 Clef，一次問六個是非題：
   - **這些修改需要跑測試、建置或其他檢查嗎？** 程式碼和建置、CI 設定通常需要；文件、註解、筆記通常不用。
   - 最後一次修改之後，有沒有跑涵蓋這些修改的檢查？
   - 那些檢查有沒有通過？
   - 最後回覆說的事，步驟裡都有依據嗎？
   - 你的要求有沒有部分沒做完，回覆裡也沒交代？
   - 最後回覆是不是在問你問題、等你決定？
5. Clef 的判斷：
   - 需要檢查，但 Clef 有把握（達到 `threshold`）沒跑 → 退回：請先跑檢查。
   - 需要檢查、也跑了，但有把握沒通過 → 退回：請修正或說明。
   - 有把握回覆說了沒有依據的事 → 退回：請先驗證或修改回覆。
   - 有把握要求沒做完 → 退回：請對照要求檢查，刻意不做就說明原因。
   - Claude 正在問你問題 → 不退回，讓你回答。
6. 退回時，Claude 會讀到上面列出的原因（檢查沒通過時附上 Clairic 抽到的依據）並繼續工作。如果它認為確實不需要，可以在回覆裡說明原因，下一次檢查時 Clef 會看到這段說明。

即使 Clairic 抽到失敗的數字，要不要退回仍由 Clef 決定（例如失敗和這次修改無關、回覆也說明了的情況）。不需要測試的修改（例如只改文件）由 Clef 的第一個問題判斷，不用另外設定例外規則。

### 送出去的資料

- 每次檢查都會送到 Cloudflare Workers AI。Cloudflare 聲明不讀取、不儲存、不用於訓練，但送出前請確認符合你的資安要求。
- 送給 Clef 的內容：你最後一則訊息（前 1,500 字）、最近 20 個改檔步驟和最近 20 個指令（每個指令前 300 字、輸出最後 600 字）、Claude 的最後回覆（前 1,500 字），以及 Clairic 抽出的事實。
- 送給 Clairic 的內容：只有最後一次修改**之後**最近 20 個指令（每個前 300 字）和輸出的最後一段，每個最多 2,000 字（測試的總結通常在最後面）。整份控制在 16,000 字以內，讓 Clairic 一次讀完；指令多時每個分到的字數會變少。不送你的訊息和 Claude 的回覆。
- **指令輸出可能包含原始碼或記錄檔的片段。**
- 檔案路徑在專案內時改成相對路徑，在家目錄下時改成 `~/…`。
- 送出前會遮掉看起來像密碼的內容（和 clef-guard 相同的規則：`Authorization` 標頭、名稱含 `TOKEN`、`SECRET`、`PASSWORD` 的變數、常見的金鑰格式等）。這是經驗規則，不保證抓到所有密碼。

## 限制

- **它不是測試。** 模型只看步驟和輸出的片段來判斷，會判錯。它能抓到「沒跑測試就說通過」，但不會知道你的測試涵蓋得夠不夠。
- 只認得 Write、Edit、NotebookEdit 的修改。用 Bash 改檔案（例如 `sed -i`、產生程式碼的腳本）不算「改了檔案」，那個回合不會檢查。
- 只檢查主對話，不檢查 subagent。
- 只送步驟的片段。輸出很長時，關鍵的那一行可能被截掉；Clairic 讀的輸出比較長，比較不會漏掉測試的總結。
- Clairic 抽出的是它在文字裡讀到的東西：測試框架的總結格式很特別時，可能抽不到數字。這時 Clef 仍會讀輸出的片段自己判斷。
- Clef 出錯、逾時（超過 5 秒）或沒有設定 Token 時，讓 Claude 照常結束，狀態列會顯示「Clef 未判斷」或「Clef 未設定」。
- 每個改了檔案的回合結束時會多等模型的回應（只用 Clef 大約 0.5 秒，加上 Clairic 大約 1 秒）；被退回時，Claude 會再多做一輪。
