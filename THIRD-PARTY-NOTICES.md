# 第三方组件声明 / Third-Party Notices

本插件在 `vendor/everything/` 下内置了 [voidtools](https://www.voidtools.com/) 的
**Everything** 便携版与 **ES** 命令行工具，用于提供本地文件检索能力。
两者均以 **MIT 许可证**发布，明确允许使用、复制、修改、合并、发布、分发、再许可与销售。

---

## Everything（文件搜索本体）

| 项 | 值 |
|:---|:---|
| 文件 | `vendor/everything/Everything.exe` |
| 版本 | 1.5.0.1423b（x64 便携版 / Beta） |
| 版权 | Copyright (c) 2022 voidtools |
| 许可 | MIT |
| 来源 | <https://www.voidtools.com/> |
| 完整许可文本 | [`vendor/everything/LICENSE.txt`](vendor/everything/LICENSE.txt) |

## ES（Everything 命令行接口）

| 项 | 值 |
|:---|:---|
| 文件 | `vendor/everything/es.exe` |
| 版本 | 1.1.0.38（x64） |
| 版权 | Copyright (c) voidtools |
| 许可 | MIT（与 Everything 共用同一份许可） |
| 来源 | <https://www.voidtools.com/support/everything/command_line_interface/> |
| 源码 | <https://github.com/voidtools/es> |

> 「Everything」的 MIT 许可已由本插件作者**实际读取 `LICENSE.txt` 确认**
> （2026-09-30），而非依据第三方文章 —— 网上关于其授权有「MIT」与「非标准许可」
> 两种互相矛盾的说法，实读结论是标准 MIT。

---

## 我们如何使用它

- 以**独立实例名 `DSHArtifacts`** 运行，与用户自己安装（或被其他软件捆绑安装）的
  Everything **完全隔离**：各自的配置文件、数据库、进程与 IPC 窗口互不干扰。
- 索引范围**严格限制**在「DSH 工作区 + 已登记产出所在目录 + 用户手工添加的目录」，
  **不索引全盘**。实现方式：
  ```ini
  auto_include_fixed_volumes=0   ; 不自动索引任何固定卷
  ntfs_volume_paths=             ; 清空 NTFS 卷列表
  folders=<白名单目录>            ; 只索引这些
  ```
  实测效果：限定前入库 3,217,522 条 / 库文件 118 MB；
  限定后 6 条 / 库文件 422 bytes。
- 所有索引与查询**全部在本机完成**，不产生任何网络请求。
- 关闭实例时使用官方 `-exit`（让 Everything 自行保存配置），**不强杀进程**。

## 我们不做什么

- **不修改、不替换、不卸载**用户已有的 Everything 安装。
- **不读取、不上传文件内容** —— Everything 只索引文件名与路径，本插件也不读文件正文。
- 不把索引数据写出到本机之外。

---

## MIT 许可全文

```
Everything

Copyright (c) 2022 voidtools

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

（另含 Perl-Compatible Regular Expressions 的 BSD 风格许可，见 `LICENSE.txt` 第 11 行起。）
