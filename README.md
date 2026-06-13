# bid-binder-checker 投标文件装订检查 CLI

本地投标文件装订完整性检查工具。按照自定义 YAML / JSON 规则扫描资料目录，
识别缺失文件、命名错误、重复版本、顺序异常、页码不连续、签章缺失、字段过期、未纳入规则的文件等问题；
支持交互式复核（待补 / 已确认 / 忽略），带撤销、断点恢复，导出 CSV / HTML / JSON 报告。

---

## 特性

- ✅ **规则驱动**：YAML 或 JSON 格式配置章节规则
- ✅ **丰富检查项**：
  - 必需文件（支持可选）
  - 文件命名模式（正则 + 版本号提取）
  - 目录顺序校验
  - 页码范围 & 连续性
  - 过期日期字段（从文件名提取日期与当前日期对比）
  - 签章要求（按文件名关键字）
  - 未纳入规则的文件检测
- ✅ **复核流程**：待补 / 已确认 / 忽略，记录处理人 & 备注 & 完整变更历史
- ✅ **多人协作**：`claim` 领取 / `assign` 转派，冲突保护，跨重启持久化
- ✅ **状态持久化**：批次状态保存到本地 `.bbcheck/` 目录
- ✅ **撤销支持**：所有操作可撤销（内存栈，批次内生效）
- ✅ **断点恢复**：`resume` 命令可重启后继续处理上次批次
- ✅ **重复扫描防护**：同一目录再次扫描会提示（可 `--force` 强制）
- ✅ **稳定异常处理**：
  - 规则文件格式错误（字段缺失、YAML 语法错）
  - 资料目录不存在
  - 空撤销栈
  - 目录已扫描重复提示
- ✅ **多种导出**：CSV（带 BOM Excel 友好）/ HTML（美观可视化）/ JSON（机器可读）

---

## 安装

要求 Node.js >= 14。

```bash
npm install
```

可选的全局安装（之后可用 `bbcheck` 命令）：

```bash
npm link
```

不全局安装时，以下所有 `bbcheck` 命令替换为 `node src/cli.js`。

---

## 快速开始

### 1. 初始化样例（推荐首次使用）

```bash
bbcheck init-samples
# 或
node src/cli.js init-samples --out-dir ./bid-samples
```

自动生成样例规则 `bid-samples/rule.yaml` 和样例资料目录 `bid-samples/资料目录`（故意包含多种问题）。

### 1.5 预览规则（推荐正式 scan 前执行）

```bash
bbcheck validate bid-samples/rule.yaml bid-samples/资料目录
# 或机器可读输出
bbcheck validate bid-samples/rule.yaml bid-samples/资料目录 --json
```

预览输出：章节数、必需文件数、命名规则数、配置错误（缺字段 / 坏正则 / 同名章节 / order 冲突）、警告（目录未映射 / 顺序不符）、章节目录匹配预览。
有错误时进程以非零退出码返回，且**不会写入 `.bbcheck/` 状态目录、不会创建批次**，可反复执行。

### 2. 扫描目录

```bash
bbcheck scan samples/rule.yaml samples/资料目录
```

预期输出：
- 成功加载规则（章节数）
- 扫描完成，发现 N 个问题
- 问题表格（类型 / 严重 / 状态 / 章节 / 描述）
- 汇总：按类型 & 按复核状态统计

### 3. 交互式复核

```bash
bbcheck review --handler 张三
```

程序会逐个显示待补问题，选择：
- 待补（默认，稍后处理）
- 已确认（确认问题存在）
- 忽略（非关键问题）
- 跳过 / 停止

也可以批量复核：

```bash
# 批量把类型为 UNTRACKED_FILE 的全部标记为忽略
bbcheck review -s ignored --type UNTRACKED_FILE -H 李四 -r "规则外临时资料"

# 按问题ID批量指定
bbcheck review -s confirmed --ids "ISSUE_xxx,ISSUE_yyy" -H 王五
```

### 4. 撤销上一步

```bash
# 撤销上一步操作
bbcheck carryover           # 撤销
bbcheck undo --dry-run # 仅查看不执行
```

每次复核、批量更新、复用上次处理结果、甚至扫描本身都可撤销，直到栈清空。

### 4.5 复用上次处理结果

当重新 `scan` 同一资料目录（或 `--force` 生成新批次）后，可以把上一批次里相同问题的复核状态、处理人和备注带到当前批次：

```bash
bbcheck carryover                 # 自动查找同目录上一批次
bbcheck carryover --from BATCH_xxx  # 指定来源批次
bbcheck carryover BATCH_yyy       # 指定当前批次（默认激活批次）
```

匹配规则：**类型 + 目标路径 + 章节 + 描述**完全一致才带入；仅类型/路径/章节匹配但描述变化时会列出供人工确认；当前批次已手动处理的问题不会被覆盖。操作写入复核历史，支持 `undo` 撤回。

### 5. 继续上次处理（重启后）

```bash
bbcheck resume
```

自动恢复最近激活的批次。或指定批次 ID：

```bash
bbcheck resume BATCH_xxxxxx
```

### 6. 导出报告

```bash
bbcheck export report.html    # HTML 可视化报告
bbcheck export report.csv     # CSV（Excel 可读）
bbcheck export report.json    # JSON 完整数据
bbcheck export report --format html  # 强制格式
```

导出的报告 **反映当前复核状态**（每个问题的状态、处理人、备注、变更历史）。

---

## 规则文件详解

支持 `.yaml` / `.yml` / `.json`。

### 顶层字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | **必需** 规则名称 |
| `description` | string | 说明 |
| `version` | string | 版本号 |
| `globalNamingPattern` | string | 全局命名正则（章节未指定时使用） |
| `globalSignatureRequired` | bool | 全局是否要求签章 |
| `globalExpiryField` | object | 全局过期字段配置 |
| `globalPageRange` | string/object | 全局页码范围，如 `"1-50"` 或 `{start:1,end:50}` |
| `sections` | array | **必需** 章节列表 |

### sections 章节字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | **必需** 章节名称（需唯一） |
| `order` | number | 顺序号，用于校验目录物理顺序 |
| `directory` | string | 对应的子目录名（相对于根目录） |
| `description` | string | 说明 |
| `requiredFiles` | array | 必需文件列表（见下） |
| `namingPatterns` | array | 命名模式列表（见下） |
| `pageRange` | string/object | 本章节页码范围 |
| `expiryField` | object | 本章节过期字段配置 |
| `signatureRequired` | bool | 本章节文件是否都需要签章标识 |
| `allowUntracked` | bool | 是否允许本章节内存在规则外文件（默认 false） |

### requiredFiles 元素

可以是**字符串**（直接写相对路径，表示必存在、精确匹配），也可以是对象：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | **必需** 文件相对路径（章节目录下） |
| `optional` | bool | 是否可选（缺了不报缺失） |
| `signatureRequired` | bool/null | 单独指定是否需要签章（覆盖章节/全局） |
| `pageRange` | string/object | 单独的页码范围 |
| `description` | string | 说明 |

### namingPatterns 元素

可以是字符串（正则），也可以是对象：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `pattern` | string | **必需** 正则表达式 |
| `label` | string | 人类可读标签 |
| `extractVersion` | bool | 是否用该正则提取版本号（用于重复版本检测） |
| `versionGroup` | number | 正则捕获组序号，从 1 开始（默认 1） |

### 完整样例

见 `samples/rule.yaml`。

---

## 问题类型一览

| 类型常量 | 中文 | 说明 |
| --- | --- | --- |
| `MISSING_FILE` | 缺失文件 | requiredFiles 中找不到非 optional 的文件 |
| `NAMING_ERROR` | 命名错误 | 文件名不符合 namingPatterns 任何一个 |
| `DUPLICATE_VERSION` | 重复版本 | 同名文件被提取出多个版本号 |
| `ORDER_ERROR` | 顺序异常 | 子目录的物理顺序与 order 字段不匹配 |
| `PAGE_DISCONTINUITY` | 页码不连续 | 范围内有缺页、页重复、超范围 |
| `UNTRACKED_FILE` | 未纳入规则 | 文件既不在 requiredFiles，也未匹配命名模式所在章节的 allowUntracked |
| `EXPIRED_FIELD` | 字段过期 | 文件名中提取的日期早于今天 |
| `MISSING_SIGNATURE` | 缺少签章 | 要求签章但文件名不含 `签章/盖章/签名/签字/_signed/已签章` 等关键字 |

---

## 命令总览

> 顺序与 `bbcheck --help` 输出保持一致。

```
bbcheck validate <rule> [dir]    # 校验规则 + 预览目录匹配（不写状态、不生成批次，支持 --json）
bbcheck scan <rule> <dir>        # 按规则扫描资料目录
bbcheck resume [batchId]         # 恢复处理（继续上次未完成的批次）
bbcheck review                   # 交互式复核问题（或批量复核）
bbcheck status                   # 查看当前批次状态
bbcheck undo                     # 撤销上一步操作
bbcheck claim                    # 领取问题（多人协作，按类型/ID/章节）
bbcheck assign <target>          # 转派问题给其他人（需 --force 覆盖已有负责人）
bbcheck carryover [batchId]      # 复用上次处理结果（从上一批次带入复核状态）
bbcheck export <output>          # 导出复核报告（csv/html/json）
bbcheck list                     # 列出所有扫描批次
bbcheck history <issueId>        # 查看单个问题的复核历史
bbcheck baseline <sub>           # 基线管理：save/diff/list/export/import
bbcheck profile <sub>            # 规则包管理：add/list/show/use/export/import/remove
bbcheck init-samples             # 生成样例规则和资料目录
```

每个命令加 `--help` 查看参数，例如：

```bash
bbcheck validate --help
bbcheck scan --help
bbcheck review --help
```

> 💡 **推荐工作流**：正式 `scan` 前先跑 `bbcheck validate rule.yaml [资料目录]`，
> 可以先看章节数、必需文件数、命名规则数、配置问题和目录匹配预览，
> 缺字段、坏正则、目录不可读、同名章节或 order 冲突都会有清楚错误提示，进程非零退出码。
> 加 `--json` 可获得机器可读的 `warnings / errors / summary / directoryPreview`。

---

## 基线管理 (baseline)

将某次 scan 结果保存为基线，后续批次与之做差异对比，追踪新增/已消失/状态变化。
数据保存在 .bbcheck/baselines/ 目录下（每个基线一个 <名称>.json 文件），重启后可找回。

### baseline save --name <名称>

将当前激活批次的扫描结果保存为基线。同名基线默认不覆盖（加 --force 强制覆盖），保存后支持 bbcheck undo 撤回。

### baseline diff --name <名称>

将当前激活批次与指定基线做差异对比。差异分类：新增、已消失、变化（状态/负责人/备注/严重度/描述）、未变。
支持 -o <文件> 导出差异报告（JSON/CSV/HTML），退出码：0 无差异 / 2 存在差异 / 3 规则/目录不匹配。

### baseline list

列出所有已保存的基线，损坏的基线会标记为已损坏。

### baseline export --name <名称> -o <文件>

将基线导出为 JSON 文件，可在另一台机器上导入。

### baseline import --file <文件>

从 JSON 文件导入基线，支持 --force 覆盖同名、--rename 重命名，导入后支持 bbcheck undo 撤回。

| 场景 | 退出码 | 说明 |
| --- | --- | --- |
| 同名基线已存在 | 1 | 提示使用 --force |
| 损坏导入文件 | 2 | 提示文件已损坏 |
| 规则/目录不匹配 | 3 | diff 时基线与当前批次的规则或目录不同 |
| 无激活批次 | 1 | 提示先运行 scan 或 resume |
| 存储目录不可写 | 4 | 提示权限不足 |
| 差异存在 | 2 | diff 发现新增/已消失/变化 |

---

## 异常场景说明

> 以上异常在 `validate` 预览阶段同样会被检测，且在正式 `scan` 之前以非零退出码报告，避免生成无效批次。

1. **配置写错（YAML 语法错 / 必填字段缺失 / 坏正则 / 同名章节 / order 冲突）**：
   - 抛 `RuleValidationError`，CLI 显示具体行号列号和字段名，进程退出码 1
2. **目录不存在 / 非目录 / 不可读**：
   - 抛 `DirectoryNotFoundError`，CLI 显示路径，退出码 1
3. **空撤销栈**：
   - 抛 `EmptyUndoStackError`，CLI 给出黄色提示"撤销栈为空"，退出码 0（稳定）
4. **重复扫描同一目录**：
   - 第二次扫描会提示"该目录已有扫描记录：最近时间 + 批次 ID"，显示上一次结果，退出码 0
   - 强制重新扫描加 `--force`

---

## 状态文件结构

状态默认保存在运行目录下的 `.bbcheck/`（可通过 `--store-dir` 覆盖）：

```
.bbcheck/
├── active-batch           # 当前激活的批次 ID（一行纯文本）
├── index.json             # 批次索引 & 目录签名（用于重复扫描检测）
├── state.json             # 所有批次聚合快照
├── undo-stack.json        # 撤销栈（持久化，重启后可继续撤销）
├── batch_<id>.json        # 每个批次单独持久化（冗余，防 state.json 损坏）
└── baselines/             # 基线数据目录
    ├── v1.json            # 基线 v1
    └── v2.json            # 基线 v2
```

建议将 `.bbcheck/` 加入 `.gitignore`。

---

## 典型完整工作流

```bash
# 1) 首次
npm install
node src/cli.js init-samples --out-dir ./mybid

# 2) 扫描
node src/cli.js scan mybid/rule.yaml mybid/资料目录

# 3) 复核一部分，按 Ctrl+C 或选择停止
node src/cli.js review --handler 张三

# 4) 第二天继续（resume 自动载入上次批次）
node src/cli.js resume
node src/cli.js review --handler 李四

# 5) 标记错了？撤销
node src/cli.js undo
node src/cli.js undo   # 再撤销一次

# 6) 批量忽略"未纳入规则"类问题
node src/cli.js review -s ignored --type UNTRACKED_FILE -H 李四 -r "不影响装订"

# 7) 重新扫描同一目录（例如资料更新后）
node src/cli.js scan --force mybid/rule.yaml mybid/资料目录

# 8) 复用上次处理结果（自动带入相同问题的状态/处理人/备注）
node src/cli.js carryover
# 若误带入？撤销
node src/cli.js undo

# 8.5) 保存基线，后续对比差异
node src/cli.js baseline save --name v1
# 重新扫描后对比
node src/cli.js scan --force mybid/rule.yaml mybid/资料目录
node src/cli.js baseline diff --name v1
# 导出差异报告
node src/cli.js baseline diff --name v1 -o diff.html
# 撤销保存基线
node src/cli.js undo

# 8.6) 导出/导入基线（跨机器共享）
node src/cli.js baseline export --name v1 -o v1-baseline.json
node src/cli.js baseline import --file v1-baseline.json

# 8.7) 登记常用规则为 profile，后续复用
node src/cli.js profile add --name audit-v1 --rule mybid/rule.yaml
# 查看已登记的 profile
node src/cli.js profile list
# 查看 profile 详情
node src/cli.js profile show --name audit-v1
# 使用 profile 扫描（无需再传规则路径）
node src/cli.js profile use --name audit-v1 --dir mybid/资料目录
# 撤销 profile 登记
node src/cli.js undo
# 导出/导入 profile（团队共享）
node src/cli.js profile export --name audit-v1 -o audit-profile.json
node src/cli.js profile import --file audit-profile.json --rename audit-copy
# 删除 profile
node src/cli.js profile remove --name audit-copy

# 9) 导出 HTML 报告发给同事
node src/cli.js export report.html

# 10) 同时导出 CSV 留档
node src/cli.js export report.csv
```

打开 `report.html` 可以看到：
- 汇总卡（总数 / 待补 / 已确认 / 忽略 百分比）
- 按问题类型分布卡片
- 完整问题明细表，带复核历史
