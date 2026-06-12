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
bbcheck undo           # 撤销
bbcheck undo --dry-run # 仅查看不执行
```

每次复核、批量更新、甚至扫描本身都可撤销，直到栈清空。

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

```
bbcheck scan <rule> <dir>       # 按规则扫描资料目录
bbcheck review                  # 交互式复核（或批量复核）
bbcheck undo                    # 撤销上一步
bbcheck resume [batchId]        # 恢复上次处理
bbcheck status                  # 查看当前批次
bbcheck list                    # 列出所有批次
bbcheck history <issueId>       # 查看单个问题的复核历史
bbcheck export <output>         # 导出报告（csv/html/json）
bbcheck init-samples            # 生成样例规则和资料目录
```

每个命令加 `--help` 查看参数，例如：

```bash
bbcheck scan --help
bbcheck review --help
```

---

## 异常场景说明

1. **配置写错（YAML 语法错 / 必填字段缺失）**：
   - 抛 `RuleValidationError`，CLI 显示具体行号列号和字段名，进程退出码 1
2. **目录不存在**：
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
├── batch_<id>.json        # 每个批次单独持久化（冗余，防 state.json 损坏）
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

# 7) 导出 HTML 报告发给同事
node src/cli.js export report.html

# 8) 同时导出 CSV 留档
node src/cli.js export report.csv
```

打开 `report.html` 可以看到：
- 汇总卡（总数 / 待补 / 已确认 / 忽略 百分比）
- 按问题类型分布卡片
- 完整问题明细表，带复核历史
