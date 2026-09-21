const { app, BrowserWindow, ipcMain, screen } = require("electron");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const { SessionMonitor, startServer } = require("../bridge/agentdesk-session-monitor.js");

const PREFERRED_MONITOR_PORT = 4317;
const INITIAL_WINDOW_WIDTH = 520;
const INITIAL_WINDOW_HEIGHT = 360;
const MIN_WINDOW_WIDTH = 220;
const MIN_WINDOW_HEIGHT = 180;
const MAX_WINDOW_WIDTH = 1800;
const MAX_WINDOW_HEIGHT = 1200;
const SCREEN_MARGIN = 24;

let mainWindow = null;
let monitorServer = null;
let localMonitor = null;
let hasSizedToContent = false;

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

  mainWindow.once("ready-to-show", () => mainWindow.show());

  mainWindow.on("closed", () => {
    mainWindow = null;
    hasSizedToContent = false;
  });
}

function clampWindowSize(width, height, workArea) {
  const availableWidth = Math.max(MIN_WINDOW_WIDTH, workArea.width - SCREEN_MARGIN * 2);
  const availableHeight = Math.max(MIN_WINDOW_HEIGHT, workArea.height - SCREEN_MARGIN * 2);
  return {
    width: Math.min(MAX_WINDOW_WIDTH, availableWidth, Math.max(MIN_WINDOW_WIDTH, Math.round(Number(width) || INITIAL_WINDOW_WIDTH))),
    height: Math.min(MAX_WINDOW_HEIGHT, availableHeight, Math.max(MIN_WINDOW_HEIGHT, Math.round(Number(height) || INITIAL_WINDOW_HEIGHT)))
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
  nextBounds.x = Math.max(nextBounds.x, workArea.x + SCREEN_MARGIN);
  nextBounds.y = Math.max(nextBounds.y, workArea.y + SCREEN_MARGIN);

  mainWindow.setBounds(nextBounds);
}

ipcMain.handle("office-data:read", async (event) => {
  if (event.sender !== mainWindow?.webContents) throw new Error("Untrusted AgentDesk data request");
  const filePath = path.join(__dirname, "..", "wireframes", "agentdesk-office-data.json");
  return JSON.parse(await fs.readFile(filePath, "utf8"));
});

ipcMain.on("window:resize-to-content", (event, payload = {}) => {
  if (event.sender !== mainWindow?.webContents) return;
  resizeWindowToContent(payload.width, payload.height);
});

ipcMain.on("window:move-by", (event, payload = {}) => {
  if (event.sender !== mainWindow?.webContents || !mainWindow || mainWindow.isDestroyed()) return;
  const deltaX = Number(payload.deltaX);
  const deltaY = Number(payload.deltaY);
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
  const bounds = mainWindow.getBounds();
  mainWindow.setPosition(Math.round(bounds.x + deltaX), Math.round(bounds.y + deltaY));
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
