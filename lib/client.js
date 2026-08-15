/**
 * dsh-artifact-library — 客户端插件（web GUI 侧边栏入口）
 *
 * 在侧边栏「工作区」列表正下方注入一个「产物库」按钮，点击跳转到
 * /ext/artifact-library/ 管理页。
 *
 * 采用与皮肤插件相同的 __ModuleLoader__.load 格式（手写，无需构建）；
 * apply(ctx) 内直接操作 DOM，用轻量定时器对抗 React 重渲染导致的节点丢失。
 */
window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-artifact-library",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var STYLE_ID = "@dsh-external/dsh-artifact-library/sidebar-entry.css";
    var BUTTON_CLASS = "dsh-artifact-library-entry";

    var css = [
      "." + BUTTON_CLASS + "{",
      "  display:flex;align-items:center;gap:8px;margin:6px 10px;padding:8px 12px;",
      "  border-radius:8px;cursor:pointer;user-select:none;",
      "  font-size:13px;font-weight:600;line-height:1.4;",
      "  color:var(--dsw-alias-label-primary, #e6edf3);",
      "  background:var(--dsw-alias-interactive-bg-hover, rgba(127,160,255,.08));",
      "  border:1px solid var(--dsw-alias-border-l2, #2a3242);",
      "  transition:background .15s, border-color .15s;",
      "}",
      // 流式布局：按钮插在工作区列表与设置脚之间，自然不重叠
      "." + BUTTON_CLASS + ":hover{",
      "  background:var(--dsw-alias-interactive-bg-hover-solid, rgba(127,160,255,.16));",
      "  border-color:var(--dsw-alias-brand-primary, #4da3ff);",
      "}",
      "." + BUTTON_CLASS + " .alf-icon{font-size:16px;line-height:1}",
      "." + BUTTON_CLASS + " .alf-label{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "body[data-ds-collapsed] ." + BUTTON_CLASS + "{display:none}",
    ].join("\n");

    function injectCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]")) return;
      var tag = document.createElement("style");
      tag.setAttribute("data-plugin-css", STYLE_ID);
      tag.textContent = css;
      (document.head || document.documentElement).appendChild(tag);
    }

    function makeButton() {
      var btn = document.createElement("div");
      btn.className = BUTTON_CLASS;
      btn.setAttribute("role", "button");
      btn.setAttribute("tabindex", "0");
      btn.title = "打开产物库管理页（新标签页）";
      btn.innerHTML = '<span class="alf-icon">🐋</span><span class="alf-label">产物库</span>';
      btn.addEventListener("click", function () { window.open("/ext/artifact-library/", "_blank"); });
      btn.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); window.open("/ext/artifact-library/", "_blank"); }
      });
      return btn;
    }

    function apply(ctx) {
      injectCss();
      var timer = setInterval(function () {
        if (typeof document === "undefined") return;
        var col = document.querySelector(".cXnCAq_sidebarCol");
        if (!col) return;
        if (col.querySelector("." + BUTTON_CLASS)) return;
        var btn = makeButton();
        // 插到设置脚正上方（工作区列表与设置之间）
        var foot = col.querySelector(".mSGvra_footArea") || col.querySelector(".mSGvra_settingsArea");
        if (foot && foot.parentElement) {
          foot.parentElement.insertBefore(btn, foot);
        } else {
          col.appendChild(btn);
        }
      }, 1500);
      return function () {
        clearInterval(timer);
        if (typeof document !== "undefined") {
          var nodes = document.querySelectorAll("." + BUTTON_CLASS);
          for (var i = 0; i < nodes.length; i++) nodes[i].remove();
        }
      };
    }

    exports.apply = apply;
    return module.exports;
  },
});
