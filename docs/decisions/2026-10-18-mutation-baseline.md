# 变异测试基线：scope.js / gate.js 靶区（2026-10-18）

规程要求「用变异得分验收，不是覆盖率」，并要求存活变异体逐条给结论。这里是那一次跑的完整账。

## 结论

| | 变异体 | KILLED | 存活 | 得分 |
| --- | --- | --- | --- | --- |
| 第一次（基线） | 151 | 115 | 36 | **76.16%** |
| 补测试后 | 151 | 138 | 13 | **91.39%** |

剩下的 13 个**逐个判定为等价变异体**，不是"懒得补"。阈值因此设为 **90%**（棘轮：设在实测值下方 1.4 个点）。

靶区：`src/core/scope.js`、`src/core/gate.js`（权限与准入语义 —— 变异体存活等于无保护）。
测试集：`tests/team-scope.test.mjs`、`tests/experience-gate.test.mjs`、`tests/gate-scope-hardening.test.mjs`。

## 执行卫生（playbook §7，全部落在 `scripts/quality/mutate.mjs` 里）

1. 跑在**副本**上（`mkdtemp` + `node_modules` 软链），不碰生产在用的目录树。
2. 每个变异体跑完断言**源文件仍是变异体**（测试运行器没动它），还原后再断言**已还原**。
3. 存活的变异体**重跑 2 次**，任一次死掉算"不稳定"而不是存活（`KILLED*`）。
4. 有界：`--max` / `--timeout`，到点如实报"部分"，不把截断当全量。
5. 注释先被 mask，避免生成"只改注释"的等价变异体。
6. 每次跑前先验**基线**必须绿；基线不绿直接退出（先修基线再谈变异）。

## 第一次跑暴露的真缺口（已补测试，36 → 13）

| 缺口 | 补的断言 |
| --- | --- |
| `KEEP_SCORE` / `DROP_SCORE` 的**等号**没人踩到（`>=`→`>`、`<=`→`<` 都能过） | 打分**恰好等于**阈值 ±2 的两个用例 |
| 工具输出判定里 `&&` 与 `>=` 的两个条件都没验边界 | 2 行（不足 3 行）、4 行占 2 行（恰好一半）、diff 三连 |
| `DEFAULT_VISIBILITY` 常量本身没断言 | 字面量断言 + "缺 visibility 时按 team 兜底"的行为 |
| `rankHits` 省略 scope、非法 scope 的行为没人锁 | 非法 scope 按 auto；省略 == auto |
| `score` 缺失时的排序、`tierLabel` 的未知 owner/未知 tier | 各一条 |
| 发给模型的提示词、`role:'user'`、`maxTokens:120` 无人断言 | 断言实际请求参数 |
| `{type:'text'}` 形式的流式块（不是裸字符串）没被覆盖 | 用该形式返回 JSON 的假 LLM |

## 剩余 13 个：等价变异体

| 位置 | 变异 | 为什么无害 |
| --- | --- | --- |
| `scope.js:25` | `TIER_RANK.public 2→3` | 只用于排序，相对大小不变（改 self/team 会撞车所以被杀） |
| `scope.js:40` | `visibleTiers` 的 `'auto'` 兜底 → `''` | `rankHits` 与 `visibleTiers` **各兜一层**，只改一处仍落到 auto |
| `scope.js:72` | `rankHits` 默认参数 `'auto'` → `''` | 同上，下一层兜底接住 |
| `scope.js:80` ×3 | `?? 0` → `?? 1` | 比较式两侧同形，只在一侧 undefined 且另一侧恰为 0 时差 ±1，且退化到 mtime 后结果不变（要专门造 fixture 才能区分，收益极低） |
| `gate.js:112` | 超时兜底 `> 0` → `> 1` | 只有 `timeoutMs === 1` 才不同 |
| `gate.js:128` | `gateText` 默认 `mode='heuristic'` → `''` | 下一行 `GATE_MODES.includes` 兜底接住 |
| `gate.js:129` | 非法 mode 兜底 `'heuristic'` → `''` | `'' !== 'off'`，仍走启发式，`via` 不变 |
| `gate.js:136` | `mode === 'strict' && llm` → `\|\|` | `llm` 为 null 时 `\|\|` 也进分支，但 `llmGate(null)` 返回 null → 仍降级，行为一致 |
| `gate.js:89/90` | 提示词里的 `true`/`false` 字面 | 提示词**文案**级差异；模型照旧。想锁就得把整段文案复制成期望值（有镜像风险），当前选择不锁 |

`scope.js:40` / `:72` 与 `gate.js:128` / `:129` 是**同一模式**：防御性的双层兜底让单点改动无害。
保留双层的理由：兜底是给"调用方传了脏值"用的，删掉任一层都要重新论证；而它们都不会被单测区分，
所以标为等价而不是硬凑测试（playbook §7.5：先问"去掉它行为变不变"，不变就撤回或标注）。

## 复现

```bash
npm run mutate                                  # 默认靶区 + 阈值门禁
node scripts/quality/mutate.mjs --max 200 --repeat 2   # 全量
cat reports/mutation.json                       # 机器可读结果（Git 忽略了 reports/）
```
