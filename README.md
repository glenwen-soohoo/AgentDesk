# AgentDesk

桌面常駐小工具，把本機正在跑的 AI session（Claude Code、Codex）畫成一間間等視角小辦公室裡工作的角色，讓你一眼看見：**誰在工作、誰在等你、等多久、誰卡住了**，不用一個個切視窗確認。

使用說明見 [AgentDesk 說明.md](AgentDesk%20%E8%AA%AA%E6%98%8E.md)。

## 快速開始

```bash
npm install        # 安裝相依（Electron）
npm run desktop    # 啟動桌面 app（透明常駐視窗，會自動在背景啟動唯讀的 session 監控）
```

## 打包成免安裝 exe

```bash
npx @electron/packager . AgentDesk --platform=win32 --arch=x64 --out=dist --overwrite --no-asar --ignore="node_modules"
```

產出 `dist/AgentDesk-win32-x64/AgentDesk.exe`，雙擊即開。

## 只跑監控（不開視窗）

```bash
node ./bridge/agentdesk-session-monitor.js --serve --port 4317
# GET http://127.0.0.1:4317/api/sessions
```

可調參數：`--hide-parked-minutes`（停置多久收起，預設 30）、`--remove-grace-seconds`（消失多久才移除，預設 30）、`--active-file-minutes`（Codex 活動窗口，預設 15）、`--all`（改看最近檔案）。

## 架構

```text
本機 session 紀錄                偵測與正規化              分房與渲染
Claude ~/.claude/projects  ┐
                           ├─ monitor ─ adapter ─ router ─ 辦公室 tile + 角色 + 泡泡
Codex  ~/.codex/sessions   ┘
```

| 檔案 | 職責 |
|---|---|
| `bridge/agentdesk-session-monitor.js` | 唯讀輪詢本機 session 紀錄，判斷狀態與名稱 |
| `wireframes/agentdesk-session-adapter.js` | 把不同來源狀態正規化成統一狀態與優先級 |
| `wireframes/agentdesk-office-router.js` | 決定每個角色進哪一間辦公室 |
| `wireframes/agentdesk-office-tiles-demo.html` | 主畫面：辦公室 tile、座位、角色姿態、回報泡泡 |
| `wireframes/agentdesk-office-calibration.html` | 定位校準工具（拖曳調整座位/泡泡，匯出 JSON） |
| `desktop/main.js` | Electron 外殼：透明常駐視窗，內建啟動 monitor |

## 隱私

AgentDesk **只在本機唯讀**你的 session 活動訊號（狀態、時間、名稱），**不會把對話內容送到任何外部服務**，也不會啟動、修改或終止你的 session。

## 平台

目前 session 偵測針對 **Windows**（以 PowerShell 查 `claude.exe` process）。其他平台可再擴充。
