# devflow

一套給 Claude Code 用的開發流程 skill：**先寫 spec，再寫測試，再寫程式，最後拿證據證明做完了**。靈感來自 [pstack](https://github.com/cursor/plugins/tree/main/pstack) 的「先 route 到 playbook、再一步步做」，但把重點放在 spec-driven development（SDD）和 test-driven development（TDD），並且**依照工作大小決定要走幾個階段**：一行的 bug 不用寫 spec 檔，跨模組的功能則一定要。

```
/devflow:go 使用者上傳超過 10 MB 的檔案時會逾時，請修
```

Claude 會先判斷**track**（feature / bug / refactor / spike / chore）和**大小**（S / M / L），用一行說明路線，例如 `Track: bug · Size: S · Stages: diagnose → tdd → prove → ship`，再把每個階段放進 task list 逐一執行。跳過的階段會留在清單上並註明原因。

## 安裝

在終端機的 Claude Code 中輸入：

```
/plugin install devflow --marketplace williamchen0606/claude-mods
```

## 階段與 skill

每個階段都是獨立的 skill，可以單獨呼叫：

| Skill | 做什麼 | 什麼時候用 |
| --- | --- | --- |
| `/devflow:go <任務>` | 先看有沒有沒做完的工作可以接續；沒有就分類 track、判斷大小、組出階段，然後依序執行 | 交付任何一件工作時的入口，或說「繼續」接著上次做 |
| `/devflow:spec` | 寫結構化 spec：意圖、範圍與**非目標**、編號的行為情境（S1、S2…）、介面與資料形狀、不變條件、未決問題（每題都附上預設假設）、決策紀錄 | 開始做 feature、refactor、spike，或 M/L 的 bug |
| `/devflow:plan` | 把 spec 切成可各自驗證、各自 commit 的 slice：先做會卡住別人的（共用型別、migration），再做最有風險的 walking skeleton，並決定哪些 slice 可以平行 | M/L 的工作 |
| `/devflow:tdd` | 每個 slice 紅 → 綠 → 重構。測試以情境編號命名、只斷言外部可觀察的行為、先看到它因為對的原因失敗再寫實作 | 每個 slice，以及 bug 的回歸測試 |
| `/devflow:diagnose` | 先重現、再縮小範圍找到根因、檢查同樣的問題有沒有出現在別處，最後把重現步驟交給 tdd 變成測試 | 任何「壞了」的回報 |
| `/devflow:prove` | 跑 repo 自己的檢查、對 spec 的每個情境列出指令和結果（標註 measured / inferred / guessed）、用 reviewer 的眼光讀 diff 並清掉多餘的變更 | 說「做完了」之前 |
| `/devflow:ship` | 小而有序的 commit、從 spec 產生 briefing 式的 PR 說明（Why / What changed / Scope / Tradeoffs / Blast radius / Verification）、更新 release notes、把 spec 標成 done | prove 之後 |

### Track × 大小

| | S | M | L |
| --- | --- | --- | --- |
| **bug** | diagnose → tdd → prove → ship | 加上三行 spec（修正之外還改了什麼行為） | spec 檔 → plan → 逐 slice tdd |
| **feature** | 三行 spec（寫在回覆裡）→ tdd → prove → ship | spec 檔 → plan → 逐 slice tdd → prove → ship | spec 檔（含設計、風險、rollout）→ 和你確認未決問題 → plan → 第一個 slice 後 checkpoint |
| **refactor** | 先補 characterisation test 再動結構 | spec 檔寫「不能變的行為」= 測試清單 | 加上 migrate-callers-then-delete 的順序 |
| **spike** | 三行 spec（問題、時間盒、怎樣算回答了）→ 做最便宜的實驗 → 寫下答案，不出貨 | spec 檔列選項 → 實驗 → 決策紀錄 | 每個選項一個 slice，常常平行跑，最後做比較表 |
| **chore** | 做 → prove → ship | 同左 | 影響使用者才寫 spec |

完整表格和每個階段的「完成條件」在 [skills/go/references/tracks.md](skills/go/references/tracks.md)。

## Spec 長什麼樣

一件工作一個檔案，預設放在 `docs/specs/<yyyy-mm-dd>-<slug>.md`（repo 已經有 `specs/`、`docs/rfcs/`、`docs/adr/` 這類慣例就沿用）。spec 是活的：plan 寫進 `## Plan`，prove 的證據寫進 `## Evidence`，決策隨時 append 到 decision log，所以一個檔案就能讓沒看過對話的人（包括另一個 agent）接手。

```markdown
---
title: Add retry to the uploader
status: agreed        # draft | agreed | building | done | superseded
track: feature
size: M
---

## Intent          一段話：問題、誰有這個問題、做完之後的結果。不寫解法。
## Scope and non-goals
## Behaviour       S1 Given …, when …, then …  ← 每一條就是一個測試，編號不重排
## Interfaces and data
## Invariants and constraints
## Open questions  每題都附「沒回答就照這個假設做」
## Decision log    只增不改
## Plan            由 plan 填
## Evidence        由 prove 填
```

S 大小的工作不開檔案，spec 就是回覆裡的三到五行。完整範本和好壞情境的對照在 [skills/spec/references/template.md](skills/spec/references/template.md)。

## 幾條原則

- **先同意再做**：spec 在程式之前，非目標也是 spec 的一部分；動手前先問「刪掉或改設定是不是就夠了」。
- **先測試再實作**：測行為不測實作；測試要先因為對的原因失敗；一個壞測試比沒有測試更糟，寧可改用最接近的可執行檢查並說明。
- **先證明再宣稱**：每個主張標註 measured / inferred / guessed；跳過或逾時的檢查不算通過；自己先用 reviewer 的眼光讀 diff。
- **和人、和機器合作**：可逆的事直接做，不可逆的事（force push、刪資料、部署）一定先問；小決定不等人，記下假設繼續做；狀態寫進檔案而不是對話；大範圍的閱讀和獨立的 slice 交給 subagent，設計和驗證留在主線。

全文在 [skills/go/references/principles.md](skills/go/references/principles.md)。

## 和 pstack 的差別

pstack 的作者認為「最好的 spec 就是程式碼」，所以沒有 planning skill。devflow 保留這個精神的一半：**設計**確實留在程式和測試裡，spec 不寫架構文章；但**行為**要在寫程式之前用情境列出來、編號、變成測試。另外 devflow 不綁定特定模型與 subagent 型別，沒有多模型 review panel，階段數也少得多（七個 skill，不是二十三個 playbook）。

## 進度列

`/devflow:go` 決定路線後，提示列上方會出現一行進度：

```
devflow · bug · S · diagnose ✓ › tdd ● › prove ○ › ship ⊘   隱藏
tdd：slice 1/1 · slugify strips edge hyphens · ship 跳過：user commits
```

正在跑的階段加粗，還沒跑的變暗；第二行是目前的 slice、工作名稱和跳過的階段與原因。全部完成時第二行顯示「完成」。

進度來自 skill 寫在專案根目錄（session 啟動時的目錄）的 `.devflow/state.json`（`go` 會把 `.devflow/` 加進 git 的 exclude 檔，git worktree 也適用，不會進 git）。mod 每 1.5 秒檢查一次檔案，tool call 結束時也立刻檢查，所以 Claude 一改檔案進度列就跟著變。檔案的格式在 [skills/go/SKILL.md](skills/go/SKILL.md) 的「Progress file」。

這個檔案在 session 結束後還會留著：之前的 session 已經做完的路線，新的 session 不會再顯示；還沒做完的會顯示，`/devflow:go` 收到接續那件工作的請求時也會從那裡接著做。

`/devflow-band` 不帶參數顯示目前進度和 spec 檔的路徑；`hide` / `show` 隱藏或顯示（檔案有變動時會自動再出現）；`clear` 刪除進度檔。

## 限制

- 進度列只在終端機和桌面 app 顯示（AbovePrompt 只在這兩個 surface 畫），而且要 Claude 有照 skill 寫進度檔才會更新；它是 task list 的鏡子，不是另一份計畫。
- 同一個資料夾同時開兩個 session 會共用同一份進度檔，後寫的蓋掉先寫的；要平行做兩件工作，請用不同的 git worktree。
- 安裝後，交給 Claude 工程工作時它可能會自己載入 `go`（以及 `diagnose`、`tdd`、`prove` 等階段），不一定要打 `/devflow:go`。不想要這個流程時，直接說要怎麼做即可。
- `claude plugin test` 只跑進度列的測試；skill 的行為用 `claude plugin eval mods/devflow --trust-plugin --allow-tools Write Edit Bash` 評估（會真的呼叫模型、計費）。
- spec 的位置和 commit 格式會優先遵守 repo 自己的 CONTRIBUTING / AGENTS.md / CLAUDE.md，沒有規定時才用上面的預設。
