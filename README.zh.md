# dsh-water-reminder

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的**喝水提醒**插件。

大多人埋头写代码时会忘记喝水。这个插件在会话存活期间**每 40–60 分钟随机**提醒一次，并通过三条互相独立的通道送达，漏掉一条还有两条：

| 通道 | 怎么送达 | 需要什么 |
| --- | --- | --- |
| 🖥️ 系统通知 | macOS `osascript`、Windows WinRT toast、Linux `notify-send` | `ctx.subprocess`（dsh-base 自带） |
| 💬 会话内提醒 | 以插件消息注入每个存活的根会话，助手会说一句 | `agents` 服务 |
| 🔔 浏览器通知 | 侧边栏面板监听 `reminderSeq`，由页签自己弹出通知 | 页面开着 + 用户授权 |

另外还有一个**侧边栏倒计时面板**和一个**设置页**，以及一个内嵌的 `hydration-coach` **技能**。

## 为什么是「40–60 随机」

故意不固定间隔。规律到能被预判的提醒，人会迅速学会无视它（这就是"整点喝水"类 App 被关掉的原因）。每次从区间里重新抽一个值，节奏保持不规律，提醒才有效力。

## 安装

```sh
# 从本地目录安装（会写入 profile 的 package.json 与 dsh.profile.bundles）
dsh plugin --profile web add link:/path/to/water_reminder

# 或者用打包产物
pnpm pack && dsh plugin --profile web add ./dsh-plugin-water-reminder-0.1.0.tgz
```

装完**重启 `dsh web`**：插件的定时器与工具在会话启动时挂载。同一个 profile 里不要保留两条 `water-reminder` 行——两条会各起一个定时器、各注册一次 `/water/api` 前缀路由，重复路由会让整棵插件树启动失败。

## 工具

| 工具 | 用途 |
| --- | --- |
| `water_status` | 今日进度、剩余量、杯数、连续达标天数、当前区间、安静时段、下次提醒时间、近 7 天曲线 |
| `water_log` | 记一杯（默认按配置的杯量，可传 `milliliters`、`note`）。追加式日志，不去重 |
| `water_snooze` | 顺延下次提醒，默认 5 分钟 |
| `water_control` | `start` / `stop` / `set-band` / `set-goal` / `remind-now` / `reset` |

`water_control` 写的是**运行时覆盖**（存在状态文件里），不改 profile 配置；`reset` 清掉覆盖、回到配置值。

## 配置

profile 的 `cordis.patch.yml`（或插件的 `cordis.patch.yml` 默认值）：

| 字段 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 启动时是否运行提醒循环 |
| `intervalMinMinutes` | number | `40` | 随机区间下限（分钟） |
| `intervalMaxMinutes` | number | `60` | 随机区间上限（分钟） |
| `dailyGoalMl` | number | `2000` | 每日目标 |
| `cupMl` | number | `250` | 「一杯」的容量 |
| `snoozeMinutes` | number | `5` | `water_snooze` 的默认顺延 |
| `quietHours.enabled` | boolean | `false` | 是否启用安静时段 |
| `quietHours.from` / `.to` | string | `22:00` / `08:00` | 安静时段（可跨午夜），落在窗口内的提醒顺延到窗口结束 |
| `notify.os` | boolean | `true` | 系统通知 |
| `notify.agent` | boolean | `true` | 会话内提醒 |
| `notify.sound` | boolean | `true` | 系统通知带提示音 |
| `stateFile` | string | `$DSH_HOME/water-reminder.json` | 状态文件位置 |
| `promptSection` | boolean | `true` | 是否向系统提示注入提醒说明 |
| `skill` | boolean | `true` | 是否注册内嵌的 `hydration-coach` 技能 |

区间会被夹到 `[5, 720]` 分钟；目标 `[200, 20000]` ml；杯量 `[50, 2000]` ml。**用户补丁会整体替换该行的 config**，覆盖单个字段时请把想保留的字段一起写上。

## Web 界面

- **侧边栏底部 💧 按钮**：直接显示到下次提醒的倒计时（暂停时显示「已暂停」，达标时显示 ✅）。点开是面板：今日进度条、杯数/连续天数/区间、下次提醒、近 7 天柱状图、`+250ml` 记账、稍后提醒、立刻提醒、暂停/启用，以及开启浏览器通知。
- **设置页**：完整的节奏/目标/安静时段/渠道配置，写入 `$DSH_HOME/settings.yaml` 并热生效（改区间或安静时段会立即重排定时器）。

标「需重启」的两个开关（`promptSection`、`skill`）只在加载时判断，改完要重载 Harness。

## 技能

同一份说明通过两条路送出：

1. **运行时注册**：插件挂载时调用 `ctx.skills.register()`，模型立刻能在技能目录里看到 `hydration-coach`——不需要任何文件系统技能根目录。
2. **文件形态**：`skills/hydration-coach/SKILL.md`，用于偏好文件系统技能根的部署（`~/.dsh/skills`、`~/.agents/skills`、项目的 `.dsh/skills`）。

两者由 `skill.js` 单一来源生成，`npm test` 会断言 SKILL.md 与内嵌正文逐字节一致，防止两条路漂移。改完正文跑 `npm run skill` 重新生成。

技能内容覆盖：什么时候调哪个工具、提醒消息来了该怎么回（只回一句、不展开健康科普、不打断当前任务）、记账规则、怎么调整节奏、目标怎么按体重估算（30ml × kg）、以及语气与安全边界（不做医疗论断）。

## 提醒机制的细节

- **状态归状态文件所有**：定时器、下次提醒时间、饮水日志都在 `$DSH_HOME/water-reminder.json`，写入走「临时文件 + rename」，崩溃不会截断。
- **重启不补发**：启动时若 `nextDueAt` 已过期，会重新抽一个区间，而不是把错过的提醒一次性补出来。
- **安静时段**：落在窗口内的抽签结果被推到窗口结束时刻（而不是再抽一次），行为可预期。
- **手动提醒不动节奏**：`remind-now` 只投递一次，不重置原本的下次提醒时间。
- **销毁时落盘**：插件卸载会等已入队的写入完成，最后一刻记的水不会丢。
- **定时器 `unref()`**：提醒循环不会阻止进程退出。

## 已知限制

- **只能在 Harness 存活时提醒**：没有邮件/短信/推送通道。会话关了、进程退了，就只有系统通知那条路（在进程存活期间）能到。
- **Windows toast 依赖 WinRT**：通过 `powershell -EncodedCommand`（UTF-16LE base64）调 WinRT API，避免引号和中文编码问题；若目标机器的 PowerShell 被策略限制，会退化为只写日志（其余两条通道仍在）。
- **浏览器通知需要用户手势授权**：面板底部的 🔔 按钮就是那个手势。
- **近 7 天曲线只在面板里**：`water_status` 工具返回的是压缩成一行文本的版本，避免把数组塞进工具输出 schema。

## 开发

### 前置条件

插件本身**零运行时依赖**——它依赖的 `@deepseek-ai/dsh-tools`、`dsh-llm`、`schemastery` 等都由 Harness 在运行时提供（peer dependency）。

但请注意：**开发时对齐的那几个版本尚未发布到 npm**（npm 上 `@deepseek-ai/dsh-tools` 最新只到 `0.0.1-rc.1`，本插件对的是 `0.1.2-alpha.3`）。所以全新 clone 后无法直接 `npm install` 出可跑的测试环境。设置页与配置热重载需要 Harness >= `0.1.2-alpha.3` 的宿主；更老的宿主上插件仍按启动配置运行。三个办法，任选：

```sh
# 1) 只跑不依赖 Harness 的部分（零安装，clone 后即可）
npm test              # 38 通过 / 2 跳过，跳过项会说明原因

# 2) 从本机已有的 Harness profile 复用依赖（最快，离线）
mkdir -p node_modules/@deepseek-ai
for p in cordis cosmokit dsh-llm dsh-tools dsh-settings dsh-skill dsh-system-prompt schemastery; do
  ln -sfn "$HOME/.dsh/profiles/node_modules/@deepseek-ai/$p" "node_modules/@deepseek-ai/$p"
done
npm test              # 63 通过（含真实 cordis 组合集成测试）

# 3) 从源码构建 Harness，再按它的说明链接本插件
git clone https://github.com/deepseek-ai/deepseek-harness
```

需要完整套件时用第 2 或第 3 种；只改纯逻辑（`hydration.js` / `notify.js`）用第 1 种就够。

### 脚本

```sh
npm test              # 有依赖：60 个测试；无依赖：35 通过 + 2 跳过
npm run skill         # 从 skill.js 重新生成 SKILL.md
npm run skill:check   # 校验 SKILL.md 是否已同步
```

测试分四层：

| 文件 | 覆盖 | 需要 Harness |
| --- | --- | --- |
| `test/hydration.test.js` | 纯逻辑：区间归一化、随机抽签边界、安静时段跨午夜、连续天数、统计、配置补全 | 否 |
| `test/notify.test.js` | 各平台通知命令的精确 `argv`、AppleScript/XML 转义、PowerShell 编码往返 | 否 |
| `test/skill.test.js` | 内嵌 skill 与磁盘 `SKILL.md` 逐字节一致、名称符合规范、工具名齐全 | 否 |
| `test/plugin.test.js` | 用最小假上下文跑工具行为，并断言每个工具返回值符合它自己声明的 `output.schema` | **是** |
| `test/integration.test.js` | 挂到**真实** `Context` + 真实 `tools`/`skills`/`systemPrompt` 服务上，验证依赖解析、技能可发现、卸载后干净移除、以及卸载期间不落盘 | **是** |

缺依赖时最后两个文件会**跳过并打印原因**，而不是让整个套件变红。

## 许可

MIT，见 [LICENSE](./LICENSE)。
