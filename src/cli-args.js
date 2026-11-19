/**
 * cli-args.js — 命令行参数分类（纯函数，独立成模块以便单测）
 *
 * 历史缺陷：flag 过滤只认 `--` 开头 → **单字母短 flag（-v / -l）被当成位置参数**
 * 落进 positionals，`flags.has('-v')` / `flags.has('-l')` 恒为 false ——
 * 代码里意图明确的简写（verbose、logs last）从未生效，
 * 实测 `c2b logs -l` 会把 `-l` 当 runId 报"未找到运行: -l"。
 *
 * 同时必须放过负数与含负值的配置项（`-0.5`、`brightness=-3`、runId 等）
 * —— 因此只收 **单个字母** 的短 flag（`-v`/`-l`）与 `--` 长 flag。
 *
 * @param {string} a argv 中的一项
 * @returns {boolean} 是否为 flag
 */
export function isFlagArg(a) {
  return typeof a === 'string' && (a.startsWith('--') || /^-[a-zA-Z]$/.test(a));
}
