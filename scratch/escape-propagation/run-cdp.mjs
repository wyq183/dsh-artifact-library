// run-cdp.mjs —— 用真实 Chrome 跑探针页，并用 CDP Input.dispatchKeyEvent 发**真实按键**
// （isTrusted=true，走浏览器真实输入管线），而不是页面自己 dispatchEvent。
// 只读：不碰被测仓库任何源码，只读 scratch/escape-propagation/ 下的探针页。
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "./ws-raw.mjs";

const CHROME = "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
const DIR = "C:\\Users\\Administrator\\.dsh\\profiles\\desktop\\node_modules\\@dsh-external\\dsh-artifact-library\\scratch\\escape-propagation";
const PORT = 9335;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];

const profile = mkdtempSync(join(tmpdir(), "dsh-esc-probe-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
  "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--remote-debugging-port=" + PORT, "--remote-allow-origins=*",
  "--user-data-dir=" + profile, "about:blank",
], { stdio: "ignore" });

let exitCode = 0;
try {
  let version = null;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { version = await r.json(); break; } } catch {}
    await sleep(250);
  }
  if (!version) throw new Error("Chrome DevTools endpoint 没起来");

  out.push("=== 浏览器 ===");
  out.push("Browser: " + version.Browser);
  out.push("Protocol-Version: " + version["Protocol-Version"]);
  out.push("User-Agent: " + version["User-Agent"]);
  out.push("");

  const ws = connect(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
    setTimeout(() => rej(new Error("WS 握手超时")), 8000);
  });
  out.push("WS 握手：成功（无 Origin 头）");

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.on("message", (data) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    } else if (msg.method) {
      (listeners.get(msg.method) || []).forEach((f) => f(msg.params, msg.sessionId));
    }
  });
  const send = (method, params, sessionId) => new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("超时: " + method)); } }, 20000);
  });
  const on = (method, fn) => {
    const arr = listeners.get(method) || []; arr.push(fn); listeners.set(method, arr);
  };
  const waitFor = (method, timeout = 20000) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("等 " + method + " 超时")), timeout);
    on(method, (p) => { clearTimeout(t); res(p); });
  });

  // ── 1) q1-q4.html：四条问题的引擎实测 ───────────────────────────────
  const t1 = await send("Target.createTarget", { url: "about:blank" });
  const s1 = (await send("Target.attachToTarget", { targetId: t1.targetId, flatten: true })).sessionId;
  await send("Runtime.enable", {}, s1);
  await send("Page.enable", {}, s1);
  const l1 = waitFor("Page.loadEventFired");
  await send("Page.navigate", { url: pathToFileURL(join(DIR, "q1-q4.html")).href }, s1);
  await l1;
  await sleep(500);

  const grab = async (expr, sid) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid);
    if (r.exceptionDetails) throw new Error("页面异常: " + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  out.push("");
  out.push("══════════════════════════════════════════════════════════");
  out.push(" q1-q4.html（Chrome " + version.Browser.replace("Chrome/", "") + " 真实引擎）");
  out.push("══════════════════════════════════════════════════════════");
  out.push(await grab("document.getElementById('out').textContent", s1));

  // ── 真实按键：CDP Input.dispatchKeyEvent ────────────────────────────
  out.push("");
  out.push("══════════════════════════════════════════════════════════");
  out.push(" 真实按键测试（CDP Input.dispatchKeyEvent，非页面合成）");
  out.push("══════════════════════════════════════════════════════════");
  await grab("document.getElementById('target').focus()", s1);
  out.push("按键前 __realKeyLog = " + JSON.stringify(await grab("window.__realKeyLog", s1)));
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown", key: "Escape", code: "Escape",
    windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  }, s1);
  await send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Escape", code: "Escape",
    windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  }, s1);
  await sleep(400);
  out.push("按键后 __realKeyLog = " + JSON.stringify(await grab("window.__realKeyLog", s1)));
  out.push("document.activeElement = " + await grab("document.activeElement && (document.activeElement.id || document.activeElement.tagName)", s1));

  // ── 2) probe.html：三场景肉眼判定（这里用页面自带合成 Esc 自动点）──
  const t2 = await send("Target.createTarget", { url: "about:blank" });
  const s2 = (await send("Target.attachToTarget", { targetId: t2.targetId, flatten: true })).sessionId;
  await send("Runtime.enable", {}, s2);
  await send("Page.enable", {}, s2);
  const l2 = waitFor("Page.loadEventFired");
  await send("Page.navigate", { url: pathToFileURL(join(DIR, "probe.html")).href }, s2);
  await l2;
  await sleep(500);

  const readLog = () => grab(`(function(){
    var rows = document.querySelectorAll('#logTable tr'); var a = [];
    for (var i=1;i<rows.length;i++) a.push('  ' + rows[i].querySelector('.seq').textContent + '. '
      + rows[i].querySelector('.who').textContent + ' — ' + rows[i].children[2].textContent);
    return a.join('\\n');
  })()`, s2);
  const readVerdict = () => grab("document.getElementById('verdict').textContent", s2);
  const state = () => grab("'抽屉=' + document.getElementById('lvDrawer').querySelector('.st').textContent + ' | 浮层=' + document.getElementById('lvLightbox').querySelector('.st').textContent", s2);

  for (const [btn, label] of [["btnA", "场景 A · 现状：D(document capture) + L0(document bubble)"],
                              ["btnB", "场景 B · F1：D(document capture) + L1(window capture)"],
                              ["btnC", "场景 C · F2：D(document capture, 有上层浮层→return) + L0"],
                              ["btnD", "场景 D · F1 反面：D(document capture) + L1(window bubble)"],
                              ["btnE", "场景 E · F1 + 注册顺序对调（抽屉后注册）"]]) {
    out.push("");
    out.push("══════════════════════════════════════════════════════════");
    out.push(" probe.html · " + label);
    out.push("══════════════════════════════════════════════════════════");
    await grab("document.getElementById('" + btn + "').click()", s2);
    await sleep(150);
    out.push("已注册：" + await grab("document.getElementById('liveReg').textContent", s2));
    // 用真实按键而不是页面合成按钮，保持证据强度一致
    await send("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "Escape", code: "Escape",
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    }, s2);
    await send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Escape", code: "Escape",
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    }, s2);
    await sleep(700);
    out.push("层状态：" + await state());
    out.push("调用日志：\n" + await readLog());
    out.push("判定：\n" + await readVerdict());
  }

  ws.close();
} catch (err) {
  exitCode = 1;
  out.push("运行失败: " + (err && err.stack ? err.stack : String(err)));
} finally {
  const text = out.join("\n");
  console.log(text);
  try { writeFileSync(join(DIR, "cdp-run-output.txt"), text, "utf8"); } catch {}
  try { chrome.kill(); } catch {}
  await sleep(500);
  try { process.kill(chrome.pid, "SIGKILL"); } catch {}
  process.exit(exitCode);
}
