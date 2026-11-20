/**
 * 容器重启的 profile 卫生（profile hygiene）。
 *
 * Chromium 在 profile 目录里用 SingletonLock/SingletonSocket/SingletonCookie
 * 做进程单例。lock 文件记录的是「主机名-PID」：容器每次重建主机名都不同，
 * 于是 Chrome 认为 profile 被「另一台机器」占用，直接退出（code 21），
 * 即便那个进程早已不在。表现就是「硬杀容器后，同一个 /data 卷起不来」。
 *
 * 本模块在 spawn chrome 之前清掉这三个陈旧文件。前提是契约允许：一个
 * /data 卷只由一个容器持有（产品就是这么用的）。`SUMERU_CLEAR_PROFILE_LOCK=0`
 * 可关闭该清理，用于需要在同卷上并行调试的特例。
 */
import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Chrome 的 profile 单例文件名。 */
export const PROFILE_LOCK_FILES = Object.freeze([
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
]);

/**
 * 存在性判断必须**不跟随符号链接**：Chrome 的 SingletonLock 是指向
 * `<hostname>-<pid>` 的符号链接，那个目标通常不存在，`existsSync` 会跟随
 * 链接后返回 false，于是永远清不掉。lstat 只看链接本身。
 */
function lexists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 删除 profile 目录里的陈旧单例文件。
 *
 * @param {string|undefined|null} profileDir chrome 的 --user-data-dir
 * @param {object} [options]
 * @param {boolean} [options.enabled=true] 传 false 表示不做清理
 * @param {(path: string) => void} [options.onRemove] 诊断钩子，报告被删的路径
 * @param {(path: string) => boolean} [options.existsImpl] 注入点（测试用）
 * @param {typeof rmSync} [options.removeImpl] 注入点（测试用）
 * @returns {string[]} 实际删除的路径
 */
export function clearStaleProfileLock(
  profileDir,
  {
    enabled = true,
    onRemove = () => {},
    existsImpl = lexists,
    removeImpl = rmSync,
  } = {},
) {
  if (!enabled || typeof profileDir !== "string" || profileDir === "") {
    return [];
  }
  const removed = [];
  for (const name of PROFILE_LOCK_FILES) {
    const path = join(profileDir, name);
    try {
      if (!existsImpl(path)) continue;
      // lstat 语义无关紧要：Socket 是文件、Lock 是符号链接、Cookie 是普通文件，
      // rm 的 force 能覆盖三者。
      removeImpl(path, { force: true, recursive: false });
      removed.push(path);
      onRemove(path);
    } catch {
      // 清不掉不是致命错误：chrome 自己会再判定一次。
    }
  }
  return removed;
}
