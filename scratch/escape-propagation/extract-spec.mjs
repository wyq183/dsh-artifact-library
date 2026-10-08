// extract-spec.mjs —— 从 WHATWG DOM 规范原文里定位并打印指定关键句的上下文
const URL = "https://dom.spec.whatwg.org/";
const res = await fetch(URL);
const html = await res.text();
// 去标签成纯文本
const text = html
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
  .replace(/[ \t]+/g, " ")
  .replace(/\n{2,}/g, "\n");

const needles = [
  "stop propagation flag",
  "stop immediate propagation flag",
  "canceled flag",
  "in capturing phase",
  "in bubbling phase",
  "event listener list",
  "in the order in which they were added",
  "host-defined",
  "Window object",
  "isTrusted",
  "append to an event path",
];

const out = [];
for (const n of needles) {
  out.push("############################################################");
  out.push("### 关键词: " + n);
  out.push("############################################################");
  let idx = 0, hits = 0;
  while (hits < 4) {
    const at = text.toLowerCase().indexOf(n.toLowerCase(), idx);
    if (at < 0) break;
    idx = at + n.length;
    hits++;
    const start = Math.max(0, at - 700);
    const end = Math.min(text.length, at + 900);
    out.push("--- hit " + hits + " (offset " + at + ") ---");
    out.push(text.slice(start, end).replace(/\s+/g, " ").trim());
    out.push("");
  }
  if (hits === 0) out.push("（没找到）");
  out.push("");
}
console.log(out.join("\n"));
