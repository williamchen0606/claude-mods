# claude-mods

一組 [Claude Code](https://claude.com/claude-code) 的 mods。

Mod 就是 Claude Code 的 plugin，內容是一個 TypeScript hooks 模組，可以在 Claude Code 裡加入側邊面板、提示列上方的資訊列、狀態列項目、toast 通知、slash command，或是攔截、改寫 tool call 等行為。

這個 repo 本身是一個 **plugin marketplace**，每個 mod 放在 `mods/` 下自己的資料夾，可以個別安裝。

## 安裝

在終端機的 Claude Code 中輸入（把 `<mod-name>` 換成要安裝的 mod）：

```
/plugin install <mod-name> --marketplace williamchen0606/claude-mods
```

第一次安裝時會詢問是否加入 marketplace，回答 `y`，再選擇安裝範圍（scope）即可。

> `/plugin install` 只能在終端機使用。以 user scope 安裝的 mod，在桌面 app 的 Code 分頁中也會載入。

## Mods 一覽

| Mod | 說明 |
| --- | --- |
| [image-preview](mods/image-preview) | 貼圖片到輸入框後，在上方顯示縮圖預覽，方便確認貼對圖；macOS 上還能在浮動視窗中標註後替換原圖。**目前只支援 Ghostty / kitty 終端機。** |
| [desktop-statusline](mods/desktop-statusline) | 桌面 app 的狀態列：5 小時 / 7 天用量與重置倒數（進度條）、5 小時額度還能撐多久、context 使用率、花費；用 `/desktop-statusline` 選擇要顯示的欄位，可以排成多行。 |
| [clef-guard](mods/clef-guard) | Bash 指令、寫入或修改檔案、讀取網址之前，由 Cloudflare 的決策模型 Clef 判斷風險、風險類型、是否唯讀、是否符合你的要求；有風險或屬於 `rm -rf`、刪除 git repo 這類操作時先問你，也可以自動放行唯讀動作。**需要 Cloudflare Workers AI 的 API Token。** |

## 專案結構

```
.claude-plugin/marketplace.json   # marketplace 清單，列出所有 mod
mods/<mod-name>/
  .claude-plugin/plugin.json      # mod 的 manifest
  hooks/hooks.json                # 指向 hooks 模組
  hooks/register.tsx              # hooks 模組本體
  types/index.d.ts                # 使用 $.state 時的型別定義（選用）
  tests/*.test.ts                 # claude plugin test 執行的測試
  README.md                       # 這個 mod 的說明
```

## 開發

```bash
# 直接從資料夾載入單一 mod
claude --plugin-dir mods/<mod-name>

# 驗證與測試
claude plugin validate mods/<mod-name>
claude plugin test mods/<mod-name>
```

也可以把本機 repo 加入成 marketplace：先執行 `claude plugin marketplace add .`，再用 `claude plugin install <mod-name>` 安裝。之後修改檔案，執行 `/reload-plugins` 就會生效。

新增 mod 時，除了建立 `mods/<mod-name>/`，也要在 `.claude-plugin/marketplace.json` 的 `plugins` 加上一筆。給 agent 看的詳細開發說明在 [AGENTS.md](AGENTS.md)。

每次更新的內容記錄在 [RELEASE_NOTES.md](RELEASE_NOTES.md)。修改 mod 時記得一併更新 `plugin.json` 的版本號和 release note。
