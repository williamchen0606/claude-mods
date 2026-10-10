# clef-verify

Claude 改了檔案、準備說「完成了」的時候，先讓 Cloudflare 的決策模型 [Clef](https://blog.cloudflare.com/clef-decision-models/) 檢查一次：該跑的測試有沒有跑、有沒有通過、回覆裡說的事有沒有依據、你要的東西有沒有做完。少了什麼，就把 Claude 退回去補，不會讓它直接結束。

常見的情況：Claude 改完程式說「修好了，測試通過」，但其實沒跑測試，或測試失敗了還是回報完成。

退回時，Claude 會讀到：

```
clef-verify：結束前請先處理：
· 你改了檔案，但改完之後沒有跑測試、建置或其他檢查。請跑能驗證這些修改的檢查，確認通過後再回報。
如果確定不需要，請在回覆中說明原因再結束。
```

狀態列會顯示最近一次的檢查：

```
⚠ clef-verify: 需要檢查 92% · 沒跑檢查 · 340ms · 退回 1/2
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
| `model` | `clef` | `clef`（最準）、`clef-flash`（最快、最便宜）或 `clef-omni` |
| `threshold` | `0.7` | Clef 有多少把握（0 到 1）認為少了什麼，才把 Claude 退回 |
| `maxRetries` | `2` | 你的每一則訊息最多退回幾次。用完後就讓 Claude 結束，並跳出通知告訴你 Clef 還覺得少了什麼 |

**不要把 Token 寫進任何會 commit 的檔案**（包括專案的 `.claude/settings.json`）。

## 運作方式

Claude 每次要結束回合時（Claude Code 的 Stop 事件）：

1. 這個回合（從你最後一則訊息開始）沒有用 Write、Edit 或 NotebookEdit 改過檔案 → 直接結束，不呼叫 Clef。
2. 有其他 hook 已經擋下結束，或還有背景工作在跑（Claude 只是在等它） → 不檢查。
3. 其他情況，把你的要求、Claude 這個回合做的步驟（改了哪些檔案、跑了哪些指令、指令是否失敗、輸出的最後一段），以及 Claude 的最後回覆送給 Clef，一次問六個是非題：
   - **這些修改需要跑測試、建置或其他檢查嗎？** 程式碼和建置、CI 設定通常需要；文件、註解、筆記通常不用。
   - 最後一次修改之後，有沒有跑涵蓋這些修改的檢查？
   - 那些檢查有沒有通過？
   - 最後回覆說的事，步驟裡都有依據嗎？
   - 你的要求有沒有部分沒做完，回覆裡也沒交代？
   - 最後回覆是不是在問你問題、等你決定？
4. Clef 的判斷：
   - 需要檢查，但 Clef 有把握（達到 `threshold`）沒跑 → 退回：請先跑檢查。
   - 需要檢查、也跑了，但有把握沒通過 → 退回：請修正或說明。
   - 有把握回覆說了沒有依據的事 → 退回：請先驗證或修改回覆。
   - 有把握要求沒做完 → 退回：請對照要求檢查，刻意不做就說明原因。
   - Claude 正在問你問題 → 不退回，讓你回答。
5. 退回時，Claude 會讀到上面列出的原因並繼續工作。如果它認為確實不需要，可以在回覆裡說明原因，下一次檢查時 Clef 會看到這段說明。

不需要測試的修改（例如只改文件）由 Clef 的第一個問題判斷，不用另外設定例外規則。

### 送出去的資料

- 每次檢查都會送到 Cloudflare Workers AI。Cloudflare 聲明不讀取、不儲存、不用於訓練，但送出前請確認符合你的資安要求。
- 送出的內容：你最後一則訊息（前 1,500 字）、最近 20 個改檔步驟和最近 20 個指令（每個指令前 300 字、輸出最後 600 字）、Claude 的最後回覆（前 1,500 字）。**指令輸出可能包含原始碼或記錄檔的片段。**
- 檔案路徑在專案內時改成相對路徑，在家目錄下時改成 `~/…`。
- 送出前會遮掉看起來像密碼的內容（和 clef-guard 相同的規則：`Authorization` 標頭、名稱含 `TOKEN`、`SECRET`、`PASSWORD` 的變數、常見的金鑰格式等）。這是經驗規則，不保證抓到所有密碼。

## 限制

- **它不是測試。** Clef 只看步驟和輸出的片段來判斷，會判錯。它能抓到「沒跑測試就說通過」，但不會知道你的測試涵蓋得夠不夠。
- 只認得 Write、Edit、NotebookEdit 的修改。用 Bash 改檔案（例如 `sed -i`、產生程式碼的腳本）不算「改了檔案」，那個回合不會檢查。
- 只檢查主對話，不檢查 subagent。
- 只送步驟的片段。輸出很長時，關鍵的那一行可能被截掉。
- Clef 出錯、逾時（超過 5 秒）或沒有設定 Token 時，讓 Claude 照常結束，狀態列會顯示「Clef 未判斷」或「Clef 未設定」。
- 每個改了檔案的回合結束時會多等一次 Clef 的回應（大約 0.5 到 1 秒）；被退回時，Claude 會再多做一輪。
