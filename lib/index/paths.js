/**
 * dsh-artifact-library — 文件索引：路径与常量
 *
 * 随包分发一份 Everything 便携版 + 官方命令行工具（ES）。
 * 两者均为 MIT 许可（见 vendor/everything/LICENSE.txt），因此可以内置分发。
 *
 * ⚠️ 三条实测结论（2026-09-30 验证，别改回去）：
 *  ① 实例的配置/数据库文件名是 **`Everything-<实例名>.ini` / `.db`**（连字符），
 *     不是 `Everything.ini` —— 写错文件名 = 配置完全不生效（白测一轮）。
 *  ② `app_data=0` 时 ini 落在 **exe 同目录**；数据库位置用 `db_location` 另指，
 *     这样包目录只留一个 ini，库放插件数据目录。
 *  ③ 强杀进程**不保存配置**，必须用 `es.exe -instance <名> -exit` 正常退出。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 插件包根目录（lib/index/ → 上两级） */
export const PKG_ROOT = path.resolve(__dirname, '..', '..')

/** 随包分发的 Everything 便携版与 ES 命令行 */
export const VENDOR_DIR = path.join(PKG_ROOT, 'vendor', 'everything')
export const EVERYTHING_EXE = path.join(VENDOR_DIR, 'Everything.exe')
export const ES_EXE = path.join(VENDOR_DIR, 'es.exe')

/**
 * 独立实例名。
 * 与用户自己安装/被捆绑安装的 Everything **完全隔离** —— 各自的 ini、db、进程、IPC 窗口。
 */
export const INSTANCE_NAME = 'DSHArtifacts'

/** 索引运行时目录（ini 之外的库文件、状态、日志） */
export function indexDir(dataDir) {
  return path.join(dataDir, 'index')
}

/** 数据库目录（经 ini 的 db_location 指定，避免写进包体） */
export function dbDir(dataDir) {
  return indexDir(dataDir)
}

/** ini 路径：app_data=0 → 与 Everything.exe 同目录 */
export function iniPath() {
  return path.join(VENDOR_DIR, `Everything-${INSTANCE_NAME}.ini`)
}

/** db 路径（Everything 会自动用 `Everything-<实例名>.db` 命名，仅在需要判断存在性时用） */
export function dbPath(dataDir) {
  return path.join(dbDir(dataDir), `Everything-${INSTANCE_NAME}.db`)
}

/** 状态文件：记录引擎上次已知状态（便于排查） */
export function statePath(dataDir) {
  return path.join(indexDir(dataDir), 'engine-state.json')
}
