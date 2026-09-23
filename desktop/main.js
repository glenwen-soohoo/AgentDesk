const { app, BrowserWindow, ipcMain, screen } = require("electron");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const { SessionMonitor, startServer } = require("../bridge/agentdesk-session-monitor.js");

// AgentDesk 是常駐小工具：主行程任何未預期例外只記錄、不彈出致命錯誤框打斷使用者。
process.on("uncaughtException", (error) => {
  console.error("[AgentDesk] uncaught exception in main process", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[AgentDesk] unhandled rejection in main process", reason);
});

const PREFERRED_MONITOR_PORT = 4317;
const INITIAL_WINDOW_WIDTH = 520;
const INITIAL_WINDOW_HEIGHT = 360;
const MIN_WINDOW_WIDTH = 220;
const MIN_WINDOW_HEIGHT = 180;
const MAX_WINDOW_WIDTH = 4000;
const MAX_WINDOW_HEIGHT = 2600;
const SCREEN_MARGIN = 24;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

let mainWindow = null;
let monitorServer = null;
let localMonitor = null;
let hasSizedToContent = false;
// 內容原始尺寸（CSS px，未乘縮放）；縮放時視窗 = 內容尺寸 × zoomFactor。
let lastContentSize = { width: INITIAL_WINDOW_WIDTH, height: INITIAL_WINDOW_HEIGHT };

function isHealthyMonitor(port) {
  return new Promise((resolve) => {
    const request = http.get(`http://127.0.0.1:${port}/api/health`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.setTimeout(400, () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

function listenToLocalMonitor(port) {
  return new Promise((resolve, reject) => {
    const monitor = new SessionMonitor({ port });
    monitor.watch(() => {});
    const server = startServer(monitor, port);
    server.once("listening", () => resolve({ port, monitor, server }));
    server.once("error", (error) => reject(error));
  });
}

async function ensureMonitor() {
  if (await isHealthyMonitor(PREFERRED_MONITOR_PORT)) {
    return { port: PREFERRED_MONITOR_PORT, server: null };
  }

  for (let port = PREFERRED_MONITOR_PORT; port < PREFERRED_MONITOR_PORT + 5; port += 1) {
    try {
      const result = await listenToLocalMonitor(port);
      localMonitor = result.monitor;
      monitorServer = result.server;
      return result;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    }
  }

  throw new Error("AgentDesk 找不到可用的 session monitor port");
}

function createWindow(monitorPort) {
  mainWindow = new BrowserWindow({
    width: INITIAL_WINDOW_WIDTH,
    height: INITIAL_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    frame: false,
    transparent: true,
    hasShadow: false,
    title: "AgentDesk",
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  mainWindow.setAlwaysOnTop(true, "floating");
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  mainWindow.setPosition(
    workArea.x + SCREEN_MARGIN,
    workArea.y + SCREEN_MARGIN
  );

  const pagePath = path.join(__dirname, "..", "wireframes", "agentdesk-office-tiles-demo.html");
  mainWindow.loadFile(pagePath, {
    query: {
      live: "1",
      endpoint: `http://127.0.0.1:${monitorPort}/api/sessions`
    }
  });

  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !(input.control || input.meta)) return;
    if (applyZoomKey(input.key)) event.preventDefault();
  });

  // Ctrl+滾輪縮放：Chromium 改了 zoom 後，同步把視窗長到對應大小。
  mainWindow.webContents.on("zoom-changed", () => applyContentSize());

  mainWindow.once("ready-to-show", () => mainWindow.show());

  mainWindow.on("closed", () => {
    mainWindow = null;
    hasSizedToContent = false;
  });
}

function clampWindowSize(width, height, workArea) {
  const availableWidth = Math.max(MIN_WINDOW_WIDTH, workArea.width - SCREEN_MARGIN * 2);
  const availableHeight = Math.max(MIN_WINDOW_HEIGHT, workArea.height - SCREEN_MARGIN * 2);
  const rawWidth = Number(width);
  const rawHeight = Number(height);
  const safeWidth = Number.isFinite(rawWidth) && rawWidth > 0 ? rawWidth : INITIAL_WINDOW_WIDTH;
  const safeHeight = Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : INITIAL_WINDOW_HEIGHT;
  // 全部 Math.round：分數 DPI 縮放下 workArea 可能是非整數，setBounds 只吃整數，
  // 否則會拋 "conversion failure from" 讓主行程崩潰。
  return {
    width: Math.round(Math.min(MAX_WINDOW_WIDTH, availableWidth, Math.max(MIN_WINDOW_WIDTH, safeWidth))),
    height: Math.round(Math.min(MAX_WINDOW_HEIGHT, availableHeight, Math.max(MIN_WINDOW_HEIGHT, safeHeight)))
  };
}

function resizeWindowToContent(width, height) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  const display = hasSizedToContent ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const size = clampWindowSize(width, height, workArea);
  const nextBounds = { ...bounds, width: size.width, height: size.height };

  if (!hasSizedToContent) {
    nextBounds.x = workArea.x + SCREEN_MARGIN;
    hasSizedToContent = true;
  }

  nextBounds.x = Math.min(nextBounds.x, workArea.x + workArea.width - size.width - SCREEN_MARGIN);
  nextBounds.y = Math.min(nextBounds.y, workArea.y + workArea.height - size.height - SCREEN_MARGIN);
  nextBounds.x = Math.round(Math.max(nextBounds.x, workArea.x + SCREEN_MARGIN));
  nextBounds.y = Math.round(Math.max(nextBounds.y, workArea.y + SCREEN_MARGIN));
  nextBounds.width = Math.round(size.width);
  nextBounds.height = Math.round(size.height);

  try {
    mainWindow.setBounds(nextBounds);
  } catch (error) {
    console.error("[AgentDesk] setBounds failed", nextBounds, error);
  }
}

function currentZoomFactor() {
  if (!mainWindow || mainWindow.isDestroyed()) return 1;
  const zoom = mainWindow.webContents.getZoomFactor();
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

// 視窗大小 = 內容原始尺寸 × 目前縮放，讓 Ctrl +/- 放大時視窗跟著長、不會被裁掉。
function applyContentSize() {
  const zoom = currentZoomFactor();
  resizeWindowToContent(lastContentSize.width * zoom, lastContentSize.height * zoom);
}

// 自己攔截 Ctrl +/- / 0：設定縮放並同步視窗大小（Chromium 內建縮放不會動視窗，導致放大看不出來）。
function applyZoomKey(key) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const web = mainWindow.webContents;
  let zoom = currentZoomFactor();
  if (key === "=" || key === "+" || key === "Add") zoom = Math.min(MAX_ZOOM, zoom + ZOOM_STEP);
  else if (key === "-" || key === "Subtract") zoom = Math.max(MIN_ZOOM, zoom - ZOOM_STEP);
  else if (key === "0") zoom = 1;
  else return false;
  web.setZoomFactor(Math.round(zoom * 100) / 100);
  applyContentSize();
  return true;
}

ipcMain.handle("office-data:read", async (event) => {
  if (event.sender !== mainWindow?.webContents) throw new Error("Untrusted AgentDesk data request");
  const filePath = path.join(__dirname, "..", "wireframes", "agentdesk-office-data.json");
  return JSON.parse(await fs.readFile(filePath, "utf8"));
});

ipcMain.on("window:resize-to-content", (event, payload = {}) => {
  if (event.sender !== mainWindow?.webContents) return;
  const width = Number(payload.width);
  const height = Number(payload.height);
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    lastContentSize = { width, height };
  }
  applyContentSize();
});

ipcMain.on("window:move-by", (event, payload = {}) => {
  if (event.sender !== mainWindow?.webContents || !mainWindow || mainWindow.isDestroyed()) return;
  const deltaX = Number(payload.deltaX);
  const deltaY = Number(payload.deltaY);
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
  const bounds = mainWindow.getBounds();
  try {
    mainWindow.setPosition(Math.round(bounds.x + deltaX), Math.round(bounds.y + deltaY));
  } catch (error) {
    console.error("[AgentDesk] setPosition failed", error);
  }
});

ipcMain.on("window:minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.on("window:close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

app.whenReady().then(async () => {
  const monitor = await ensureMonitor();
  createWindow(monitor.port);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (monitorServer) monitorServer.close();
  localMonitor = null;
});
