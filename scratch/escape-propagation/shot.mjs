// shot.mjs —— 给 probe.html 截一张图，确认中文渲染正常 + 页面布局没问题
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "./ws-raw.mjs";

const CHROME = "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
const DIR = "C:\\Users\\Administrator\\.dsh\\profiles\\desktop\\node_modules\\@dsh-external\\dsh-artifact-library\\scratch\\escape-propagation";
const PORT = 9350;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), "dsh-esc-shot-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  "--remote-debugging-port=" + PORT, "--remote-allow-origins=*",
  "--user-data-dir=" + profile, "--window-size=1280,1400", "about:blank",
], { stdio: "ignore" });

try {
  let version = null;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { version = await r.json(); break; } } catch {}
    await sleep(250);
  }
  const ws = connect(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); setTimeout(() => rej(new Error("ws timeout")), 8000); });
  let nextId = 1; const pending = new Map(); const listeners = new Map();
  ws.on("message", (d) => {
    const m = JSON.parse(d);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    else if (m.method) (listeners.get(m.method) || []).forEach((f) => f(m.params));
  });
  const send = (method, params) => new Promise((res, rej) => {
    const id = nextId++; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("timeout " + method)); } }, 20000);
  });
  const waitFor = (m) => new Promise((res) => { const a = listeners.get(m) || []; a.push(res); listeners.set(m, a); });

  const t = await send("Target.createTarget", { url: "about:blank" });
  const sid = (await send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId;
  // 带 sessionId 的发送器
  const send2 = (method, params) => new Promise((res, rej) => {
    const id = nextId++; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params: params || {}, sessionId: sid }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("timeout " + method)); } }, 20000);
  });
  await send2("Page.enable");
  await send2("Runtime.enable");
  const loaded = waitFor("Page.loadEventFired");
  await send2("Page.navigate", { url: pathToFileURL(join(DIR, "probe.html")).href });
  await loaded;
  await sleep(600);

  // 跑场景 B（F1）让页面上有结果
  await send2("Runtime.evaluate", { expression: "document.getElementById('btnB').click()", returnByValue: true });
  await sleep(200);
  await send2("Runtime.evaluate", { expression: "document.getElementById('btnEsc').click()", returnByValue: true });
  await sleep(500);

  const shot = await send2("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(join(DIR, "probe-screenshot.png"), Buffer.from(shot.data, "base64"));
  console.log("screenshot written");
  ws.close();
} catch (e) {
  console.log("ERR " + (e && e.stack ? e.stack : String(e)));
} finally {
  try { chrome.kill(); } catch {}
  await sleep(400);
  try { process.kill(chrome.pid, "SIGKILL"); } catch {}
  process.exit(0);
}
