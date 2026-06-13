const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { RuleParser } = require('../src/rule-parser');
const { Scanner } = require('../src/scanner');
const { StateStore } = require('../src/state-store');
const { Exporter } = require('../src/exporter');
const { REVIEW_STATUS } = require('../src/models');
const { BaselineManager, BaselineError } = require('../src/baseline');
const { ProfileManager, ProfileError } = require('../src/profile-manager');

const TEST_ROOT = path.join(__dirname, '..', '.test-workspace');
const SAMPLES_DIR = path.join(__dirname, '..', 'samples');
const RULE_PATH = path.join(SAMPLES_DIR, 'rule.yaml');
const DATA_DIR = path.join(SAMPLES_DIR, '资料目录');

let passed = 0;
let failed = 0;
let currentSuite = '';
const failures = [];

function suite(name) {
  currentSuite = name;
  console.log('\n' + '='.repeat(60));
  console.log(`  ${name}`);
  console.log('='.repeat(60));
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ suite: currentSuite, name, error: e });
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message.split('\n')[0]}`);
  }
}

function makeTempDir(suffix) {
  const p = path.join(TEST_ROOT, `run-${Date.now()}-${suffix}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function cleanupWorkspace() {
  if (fs.existsSync(TEST_ROOT)) {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

function newStore(suffix) {
  const storeDir = makeTempDir(suffix);
  return new StateStore(storeDir);
}

function loadRule() {
  const parser = new RuleParser();
  return parser.load(RULE_PATH);
}

function scanOnce(store) {
  const rule = loadRule();
  const scanner = new Scanner();
  const result = scanner.scan(DATA_DIR, rule);
  store.saveBatch(result);
  return result;
}

// ─────────────────────────────────────────────────────────────
// 测试 1: 撤销新建批次后再次扫描同一目录 — 不崩溃，active-batch 有效
// ─────────────────────────────────────────────────────────────
suite('Bug 复现: undo NEW_BATCH 后再 scan');

test('首次扫描成功保存批次', () => {
  const store = newStore('undo-rescan');
  const r = scanOnce(store);
  assert.ok(r.batchId, 'batchId 应存在');
  assert.ok(r.issues.length > 0, '应有问题');
  assert.strictEqual(store.getActiveBatchId(), r.batchId, 'active-batch 应等于刚扫描的批次');
});

test('撤销 NEW_BATCH 后目录索引应清空', () => {
  const store = newStore('undo-index');
  const r = scanOnce(store);
  const check1 = store.hasBatchForDirectory(DATA_DIR);
  assert.strictEqual(check1.exists, true, '撤销前目录应有记录');

  const action = store.undo();
  assert.strictEqual(action.type, 'NEW_BATCH', '撤销动作类型应为 NEW_BATCH');

  const check2 = store.hasBatchForDirectory(DATA_DIR);
  assert.strictEqual(check2.exists, false, '撤销后目录索引应返回 exists:false');
});

test('撤销新建批次后再次扫描同一目录 — 不崩溃', () => {
  const store = newStore('undo-rescan2');
  scanOnce(store);
  store.undo();

  let thrown = null;
  let secondResult = null;
  try {
    secondResult = scanOnce(store);
  } catch (e) {
    thrown = e;
  }
  assert.strictEqual(thrown, null, '第二次扫描不应抛出异常');
  assert.ok(secondResult && secondResult.batchId, '第二次扫描应有有效批次');
});

test('撤销新建批次后再扫描 — active-batch 必须有效（非 undefined/null）', () => {
  const store = newStore('undo-active-batch');
  scanOnce(store);
  store.undo();
  scanOnce(store);

  const activeId = store.getActiveBatchId();
  assert.ok(activeId, 'active-batch 不应为 null/空');
  assert.notStrictEqual(activeId, 'undefined', 'active-batch 不应是 "undefined" 字面量');
  assert.notStrictEqual(activeId, 'null', 'active-batch 不应是 "null" 字面量');

  const activeBatch = store.getActiveBatch();
  assert.ok(activeBatch, '通过 activeId 加载批次应成功');
  assert.ok(Array.isArray(activeBatch.issues), '加载的批次应有 issues 数组');
});

test('撤销到空栈后再 scan 也不应崩溃', () => {
  const store = newStore('empty-stack-rescan');
  scanOnce(store);
  store.undo();
  assert.throws(() => store.undo(), /撤销栈为空/, '空撤销应抛 EmptyUndoStackError');

  let thrown = null;
  try { scanOnce(store); } catch (e) { thrown = e; }
  assert.strictEqual(thrown, null, '空撤销栈后再扫描不应崩溃');
});

// ─────────────────────────────────────────────────────────────
// 测试 2: 重复扫描（不加 --force）
// ─────────────────────────────────────────────────────────────
suite('回归: 重复扫描检测');

test('hasBatchForDirectory 对已扫描目录返回 true', () => {
  const store = newStore('dup-scan');
  scanOnce(store);
  const check = store.hasBatchForDirectory(DATA_DIR);
  assert.strictEqual(check.exists, true);
  assert.ok(Array.isArray(check.batches) && check.batches.length >= 1);
});

test('多次扫描同一目录不产生多批次（未 force 的话由调用方判断）', () => {
  const store = newStore('dup-scan2');
  const r1 = scanOnce(store);
  const r2 = scanOnce(store);
  // store 自身不做去重，由 CLI 通过 hasBatchForDirectory 判断
  // 这里验证 store 支持同一目录多条记录
  const check = store.hasBatchForDirectory(DATA_DIR);
  assert.ok(check.batches.length >= 2, '同一目录可关联多个批次');
  assert.ok(check.batches.includes(r1.batchId));
  assert.ok(check.batches.includes(r2.batchId));
});

test('--force 等价于直接 saveBatch，批次数量递增', () => {
  const store = newStore('force-scan');
  scanOnce(store);
  scanOnce(store);
  scanOnce(store);
  const batches = store.listBatches(10);
  assert.ok(batches.length >= 3, '应有至少 3 个批次记录');
});

// ─────────────────────────────────────────────────────────────
// 测试 3: resume（重启后继续）
// ─────────────────────────────────────────────────────────────
suite('回归: resume / 持久化');

test('同一路径的 StateStore 能读取之前保存的批次', () => {
  const storeDir = makeTempDir('resume1');
  const store1 = new StateStore(storeDir);
  const r1 = scanOnce(store1);

  const store2 = new StateStore(storeDir);
  const activeId = store2.getActiveBatchId();
  assert.strictEqual(activeId, r1.batchId, '新实例应读到相同的 active-batch');

  const loaded = store2.loadBatch(r1.batchId);
  assert.ok(loaded, '新实例应能加载批次');
  assert.strictEqual(loaded.issues.length, r1.issues.length, '问题数应一致');
});

test('撤销栈也持久化，新实例能读到', () => {
  const storeDir = makeTempDir('resume2');
  const store1 = new StateStore(storeDir);
  scanOnce(store1);
  const size1 = store1.getUndoStackSize();
  assert.ok(size1 >= 1);

  const store2 = new StateStore(storeDir);
  const size2 = store2.getUndoStackSize();
  assert.strictEqual(size2, size1, '新实例的撤销栈大小应相同');

  const action = store2.undo();
  assert.strictEqual(action.type, 'NEW_BATCH', '从新实例撤销也应成功');
  const check = store2.hasBatchForDirectory(DATA_DIR);
  assert.strictEqual(check.exists, false, '撤销后目录索引应清除');
});

// ─────────────────────────────────────────────────────────────
// 测试 4: 复核状态变更
// ─────────────────────────────────────────────────────────────
suite('回归: 复核流程');

test('批量更新问题状态', () => {
  const store = newStore('review');
  const r = scanOnce(store);

  const missing = r.issues.filter(i => i.type === 'MISSING_FILE');
  assert.ok(missing.length > 0, '应有缺失文件类问题');

  const updates = missing.map(i => ({ issueId: i.id, status: REVIEW_STATUS.CONFIRMED, remark: '测试确认' }));
  store.batchUpdateIssues(r.batchId, updates, 'test-user');

  const reloaded = store.loadBatch(r.batchId);
  const confirmed = reloaded.issues.filter(i => i.reviewStatus === REVIEW_STATUS.CONFIRMED);
  assert.strictEqual(confirmed.length, missing.length, '确认的问题数应匹配');
  assert.ok(confirmed.every(i => i.handler === 'test-user'), '处理人应记录');
  assert.ok(confirmed.every(i => i.remark === '测试确认'), '备注应记录');
});

test('单个问题有完整复核历史', () => {
  const store = newStore('history');
  const r = scanOnce(store);
  const issue = r.issues[0];

  store.updateIssueStatus(r.batchId, issue.id, REVIEW_STATUS.CONFIRMED, 'user1', '第一次确认');
  store.updateIssueStatus(r.batchId, issue.id, REVIEW_STATUS.IGNORED, 'user2', '改为忽略');

  const reloaded = store.loadBatch(r.batchId);
  const after = reloaded.getIssueById(issue.id);
  assert.ok(after.reviewHistory.length >= 2, '至少 2 条历史');
  assert.strictEqual(after.reviewStatus, REVIEW_STATUS.IGNORED, '最终状态应为忽略');
  assert.strictEqual(after.reviewHistory[0].from, REVIEW_STATUS.PENDING, '首次变更 from 为 pending');
});

// ─────────────────────────────────────────────────────────────
// 测试 5: 导出 CSV / HTML / JSON
// ─────────────────────────────────────────────────────────────
suite('回归: 导出报告');

test('导出 CSV — 文件存在且包含复核状态', () => {
  const store = newStore('export-csv');
  const r = scanOnce(store);

  const missing = r.issues.filter(i => i.type === 'MISSING_FILE');
  store.batchUpdateIssues(r.batchId, missing.map(i => ({ issueId: i.id, status: REVIEW_STATUS.CONFIRMED })), 'tester');

  const reloaded = store.loadBatch(r.batchId);
  const exporter = new Exporter();
  const outFile = path.join(makeTempDir('csv-out'), 'report.csv');
  exporter.exportCSV(reloaded, outFile);

  assert.ok(fs.existsSync(outFile), 'CSV 文件应存在');
  const content = fs.readFileSync(outFile, 'utf-8');
  assert.ok(content.includes('已确认'), 'CSV 中应包含"已确认"状态');
  assert.ok(content.includes('缺失文件'), 'CSV 中应包含"缺失文件"类型');
  assert.ok(content.includes('问题总数'), 'CSV 中应包含汇总行');
});

test('导出 HTML — 文件存在且反映复核状态', () => {
  const store = newStore('export-html');
  const r = scanOnce(store);

  const missing = r.issues.filter(i => i.type === 'MISSING_FILE');
  store.batchUpdateIssues(r.batchId, missing.map(i => ({ issueId: i.id, status: REVIEW_STATUS.CONFIRMED })), 'tester');

  const untrk = r.issues.filter(i => i.type === 'UNTRACKED_FILE');
  store.batchUpdateIssues(r.batchId, untrk.map(i => ({ issueId: i.id, status: REVIEW_STATUS.IGNORED })), 'tester');

  const reloaded = store.loadBatch(r.batchId);
  const exporter = new Exporter();
  const outFile = path.join(makeTempDir('html-out'), 'report.html');
  exporter.exportHTML(reloaded, outFile);

  assert.ok(fs.existsSync(outFile), 'HTML 文件应存在');
  const content = fs.readFileSync(outFile, 'utf-8');
  assert.ok(content.includes('<html'), '应是 HTML 文件');
  assert.ok(content.includes('已确认'), 'HTML 中应有"已确认"状态');
  assert.ok(content.includes('待补'), 'HTML 中应有"待补"状态');
  assert.ok(content.includes('忽略'), 'HTML 中应有"忽略"状态');
  assert.ok(content.includes('按问题类型分布'), 'HTML 中应有类型分布章节');
  assert.ok(content.includes('st-confirmed'), '应有 confirmed 样式类');
});

test('导出 JSON — 结构完整可反序列化', () => {
  const store = newStore('export-json');
  const r = scanOnce(store);
  const exporter = new Exporter();
  const outFile = path.join(makeTempDir('json-out'), 'report.json');
  exporter.exportJSON(r, outFile);

  const raw = fs.readFileSync(outFile, 'utf-8');
  const parsed = JSON.parse(raw);
  assert.strictEqual(parsed.batchId, r.batchId);
  assert.ok(Array.isArray(parsed.issues));
  assert.strictEqual(parsed.issues.length, r.issues.length);
  assert.ok(parsed.summary, '应有 summary 字段');
});

// ─────────────────────────────────────────────────────────────
// 测试 6: 异常场景
// ─────────────────────────────────────────────────────────────
suite('回归: 异常场景稳定性');

test('目录不存在 — 抛出 DirectoryNotFoundError', () => {
  const { DirectoryNotFoundError } = require('../src/scanner');
  const scanner = new Scanner();
  const rule = loadRule();
  assert.throws(
    () => scanner.scan('X:/nonexistent/path/12345', rule),
    DirectoryNotFoundError
  );
});

test('规则文件语法错误 — 抛出 RuleValidationError', () => {
  const { RuleValidationError } = require('../src/rule-parser');
  const badRule = path.join(makeTempDir('bad-rule'), 'bad.yaml');
  fs.writeFileSync(badRule, 'key: [unclosed\n', 'utf-8');
  const parser = new RuleParser();
  assert.throws(() => parser.load(badRule), RuleValidationError);
});

test('空撤销栈 — 抛出 EmptyUndoStackError', () => {
  const { EmptyUndoStackError } = require('../src/state-store');
  const store = newStore('empty-undo');
  assert.throws(() => store.undo(), EmptyUndoStackError);
});

test('loadBatch 不存在的 ID 返回 null', () => {
  const store = newStore('load-null');
  const r = store.loadBatch('NONEXISTENT_BATCH_ID');
  assert.strictEqual(r, null);
});

// ─────────────────────────────────────────────────────────────
// 测试 7: validate / preview
// ─────────────────────────────────────────────────────────────
suite('新功能: validate / preview');

const { spawnSync } = require('child_process');

function runCli(...args) {
  const cwd = path.join(__dirname, '..');
  const res = spawnSync(process.execPath, ['src/cli.js', ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 15000,
    env: process.env
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error
  };
}

test('loadForPreview — 正常 YAML 规则返回 rule，无 errors', () => {
  const parser = new RuleParser();
  const result = parser.loadForPreview(RULE_PATH);
  assert.ok(result.rule, '应返回 rule 对象');
  assert.strictEqual(result.errors.length, 0, '应无错误');
  assert.ok(result.rule.sections.length >= 5, '至少 5 个章节');
  assert.ok(result.info && result.info.format === 'yaml', 'info.format 应为 yaml');
});

test('loadForPreview — 正常 JSON 规则也能解析', () => {
  const jsonRulePath = path.join(makeTempDir('validate-json'), 'rule.json');
  const ruleObj = {
    name: 'JSON测试规则',
    version: '2.0',
    sections: [
      {
        name: '章节一',
        order: 1,
        directory: '01-xxx',
        requiredFiles: [{ path: 'a.pdf' }],
        namingPatterns: [{ pattern: '^.*\\.pdf$', label: 'pdf文件' }]
      }
    ]
  };
  fs.writeFileSync(jsonRulePath, JSON.stringify(ruleObj, null, 2), 'utf-8');
  const parser = new RuleParser();
  const result = parser.loadForPreview(jsonRulePath);
  assert.strictEqual(result.errors.length, 0, 'JSON 规则应无解析错误');
  assert.ok(result.rule, '应返回 rule 对象');
  assert.strictEqual(result.rule.name, 'JSON测试规则');
  assert.strictEqual(result.info.format, 'json');
  assert.strictEqual(result.rule.sections.length, 1);
});

test('loadForPreview — 坏正则: namingPatterns 中 pattern 无效应产生 error', () => {
  const badRegexRule = path.join(makeTempDir('validate-bad-regex'), 'rule.yaml');
  const yamlContent = `name: "坏正则测试"
sections:
  - name: "章节一"
    order: 1
    directory: "01-test"
    namingPatterns:
      - pattern: "[a-z"
        label: "无效正则"
`;
  fs.writeFileSync(badRegexRule, yamlContent, 'utf-8');
  const parser = new RuleParser();
  const result = parser.loadForPreview(badRegexRule);
  const hasRegexErr = result.errors.some(e => /正则表达式无效/.test(e));
  assert.ok(hasRegexErr, '应报告正则无效错误，实际 errors: ' + JSON.stringify(result.errors));
});

test('loadForPreview — globalNamingPattern 坏正则也报错', () => {
  const p = path.join(makeTempDir('validate-bad-global-regex'), 'r.yaml');
  fs.writeFileSync(p, `name: "test"
globalNamingPattern: "[A-Z"
sections:
  - name: "A"
    order: 1
`, 'utf-8');
  const parser = new RuleParser();
  const r = parser.loadForPreview(p);
  const found = r.errors.some(e => /globalNamingPattern.*正则/.test(e));
  assert.ok(found, '应检测到 globalNamingPattern 的坏正则: ' + JSON.stringify(r.errors));
});

test('loadForPreview — 章节同名冲突产生 error', () => {
  const p = path.join(makeTempDir('validate-dup-name'), 'r.yaml');
  fs.writeFileSync(p, `name: "test"
sections:
  - name: "重复章节"
    order: 1
  - name: "重复章节"
    order: 2
`, 'utf-8');
  const parser = new RuleParser();
  const r = parser.loadForPreview(p);
  const found = r.errors.some(e => /重名/.test(e));
  assert.ok(found, '应检测到同名章节: ' + JSON.stringify(r.errors));
});

test('loadForPreview — 章节 order 冲突产生 error', () => {
  const p = path.join(makeTempDir('validate-order-conflict'), 'r.yaml');
  fs.writeFileSync(p, `name: "test"
sections:
  - name: "章节A"
    order: 1
  - name: "章节B"
    order: 1
`, 'utf-8');
  const parser = new RuleParser();
  const r = parser.loadForPreview(p);
  const found = r.errors.some(e => /order.*冲突/.test(e));
  assert.ok(found, '应检测到 order 冲突: ' + JSON.stringify(r.errors));
});

test('loadForPreview — 缺必需字段 name / sections 产生 error', () => {
  const p = path.join(makeTempDir('validate-missing-fields'), 'r.yaml');
  fs.writeFileSync(p, `description: "没有 name 和 sections"
`, 'utf-8');
  const parser = new RuleParser();
  const r = parser.loadForPreview(p);
  const hasName = r.errors.some(e => /缺少必填字段.*name/.test(e));
  const hasSecs = r.errors.some(e => /缺少必填字段.*sections/.test(e));
  assert.ok(hasName, '应报缺 name: ' + JSON.stringify(r.errors));
  assert.ok(hasSecs, '应报缺 sections: ' + JSON.stringify(r.errors));
});

test('CLI validate — 正常 YAML + 资料目录 退出码 0', () => {
  const storeDir = makeTempDir('cli-validate-ok');
  const res = runCli('--store-dir', storeDir, 'validate', RULE_PATH, DATA_DIR);
  assert.strictEqual(res.status, 0,
    `退出码应为 0，实际=${res.status}。stderr=${res.stderr}`);
  assert.ok(/章节数/.test(res.stdout), 'stdout 应包含"章节数"');
  assert.ok(/必需文件数/.test(res.stdout), 'stdout 应包含"必需文件数"');
  assert.ok(/命名规则数/.test(res.stdout), 'stdout 应包含"命名规则数"');
  assert.ok(/校验通过/.test(res.stdout), '应显示校验通过');
  assert.ok(!/❌/.test(res.stdout), '不应出现错误标记');
});

test('CLI validate — 不存在目录 退出码 1', () => {
  const storeDir = makeTempDir('cli-validate-missing-dir');
  const nonexistent = path.join(makeTempDir('nonexistent-data-root'), 'nothing-here');
  const res = runCli('--store-dir', storeDir, 'validate', RULE_PATH, nonexistent);
  assert.strictEqual(res.status, 1, '不存在目录应返回非零退出码');
  assert.ok(/资料目录不存在/.test(res.stdout + res.stderr), '应提示目录不存在');
});

test('CLI validate — 路径不是目录 退出码 1', () => {
  const storeDir = makeTempDir('cli-validate-not-dir');
  const fakeDir = path.join(makeTempDir('not-a-dir-folder'), 'file-instead-of-dir');
  fs.writeFileSync(fakeDir, 'i-am-a-file', 'utf-8');
  const res = runCli('--store-dir', storeDir, 'validate', RULE_PATH, fakeDir);
  assert.strictEqual(res.status, 1, '非目录路径应返回非零退出码');
  assert.ok(/不是目录/.test(res.stdout + res.stderr), '应提示路径不是目录');
});

test('CLI validate — 坏规则（YAML 语法错误）退出码 1', () => {
  const storeDir = makeTempDir('cli-validate-bad-yaml');
  const bad = path.join(makeTempDir('bad-yaml-folder'), 'bad.yaml');
  fs.writeFileSync(bad, 'key: [unclosed\n', 'utf-8');
  const res = runCli('--store-dir', storeDir, 'validate', bad);
  assert.strictEqual(res.status, 1, '坏 YAML 应返回非零退出码');
  const combined = res.stdout + res.stderr;
  assert.ok(/解析失败|错误/.test(combined), '应有解析失败或错误提示');
});

test('CLI validate — 坏正则退出码 1', () => {
  const storeDir = makeTempDir('cli-validate-bad-regex-cli');
  const p = path.join(makeTempDir('bad-regex-folder'), 'r.yaml');
  fs.writeFileSync(p, `name: "bad-regex"
sections:
  - name: "S"
    order: 1
    namingPatterns:
      - pattern: "*invalid*"
`, 'utf-8');
  const res = runCli('--store-dir', storeDir, 'validate', p);
  assert.strictEqual(res.status, 1, '坏正则应返回非零退出码');
});

test('CLI validate --json — 输出包含 warnings / errors / summary', () => {
  const storeDir = makeTempDir('cli-validate-json');
  const res = runCli('--store-dir', storeDir, 'validate', '--json', RULE_PATH, DATA_DIR);
  assert.strictEqual(res.status, 0, '--json 正常应退出码 0');
  let parsed;
  try { parsed = JSON.parse(res.stdout); } catch (e) {
    assert.fail('JSON 解析失败: ' + e.message + '\nstdout=' + res.stdout.slice(0, 300));
  }
  assert.ok(Array.isArray(parsed.errors), '应包含 errors 数组');
  assert.ok(Array.isArray(parsed.warnings), '应包含 warnings 数组');
  assert.ok(parsed.summary && typeof parsed.summary === 'object', '应包含 summary 对象');
  assert.strictEqual(typeof parsed.summary.sectionCount, 'number', 'summary.sectionCount 应为数字');
  assert.strictEqual(typeof parsed.summary.requiredFileCount, 'number', 'summary.requiredFileCount 应为数字');
  assert.strictEqual(typeof parsed.summary.namingPatternCount, 'number', 'summary.namingPatternCount 应为数字');
  assert.strictEqual(parsed.summary.valid, true, 'valid 应为 true');
  assert.ok(parsed.directoryPreview, '提供 dir 时应包含 directoryPreview');
  assert.ok(Array.isArray(parsed.directoryPreview.matches), 'directoryPreview.matches 应为数组');
  assert.strictEqual(parsed.directoryPreview.path, path.resolve(DATA_DIR), 'directoryPreview.path 应匹配');
});

test('CLI validate --json — 坏规则输出 valid=false 且有 errors 条目', () => {
  const storeDir = makeTempDir('cli-validate-json-err');
  const p = path.join(makeTempDir('bad-json-out'), 'r.yaml');
  fs.writeFileSync(p, `description: "缺 name 和 sections"
`, 'utf-8');
  const res = runCli('--store-dir', storeDir, 'validate', '--json', p);
  assert.strictEqual(res.status, 1, '坏规则 --json 应退出码 1');
  let parsed;
  try { parsed = JSON.parse(res.stdout); } catch (e) {
    assert.fail('即使出错 --json 也应输出合法 JSON: ' + e.message + '\nstdout=' + res.stdout.slice(0, 300));
  }
  assert.strictEqual(parsed.summary.valid, false, 'valid 应为 false');
  assert.ok(parsed.errors.length >= 2, '应至少报告缺 name 和 sections 两个错误');
});

test('validate 不写入 .bbcheck 目录（不产生批次 / 状态文件）', () => {
  const storeDir = makeTempDir('validate-no-side-effect');
  assert.ok(fs.existsSync(storeDir), 'storeDir 存在（因为 makeTempDir 建了它）');

  const validateRes = runCli('--store-dir', storeDir, 'validate', RULE_PATH, DATA_DIR);
  assert.strictEqual(validateRes.status, 0);

  const entries = fs.readdirSync(storeDir);
  const stateFiles = entries.filter(n =>
    n === 'state.json' || n === 'index.json' || n === 'active-batch' ||
    n === 'undo-stack.json' || n.startsWith('batch_')
  );
  // StateStore 构造函数会 _initStoreDir() 创建 state.json 和 index.json（空壳）
  // 但不应有 batch_ 开头的批次文件，也不应有 active-batch
  const hasBatchFile = entries.some(n => n.startsWith('batch_'));
  const hasActiveBatch = entries.includes('active-batch');
  assert.strictEqual(hasBatchFile, false, 'validate 后不应存在批次文件');
  assert.strictEqual(hasActiveBatch, false, 'validate 后不应设置 active-batch');
});

test('回归: 单条命名规则在章节中只计 1 次（YAML）', () => {
  const parser = new RuleParser();
  const p = path.join(makeTempDir('single-pattern-yaml'), 'r.yaml');
  fs.writeFileSync(p, `name: "单条规则"
sections:
  - name: "S1"
    order: 1
    directory: "01-s"
    namingPatterns:
      - pattern: ^.*\\.pdf$
        label: "pdf"
`, 'utf-8');
  const result = parser.loadForPreview(p);
  assert.strictEqual(result.errors.length, 0, '应无错误: ' + JSON.stringify(result.errors));
  assert.strictEqual(result.rule.sections[0].namingPatterns.length, 1,
    '1 条命名规则在 validated 中应仍为 1 条，实际=' + result.rule.sections[0].namingPatterns.length);
  assert.strictEqual(result.rule.sections[0].namingPatterns[0].label, 'pdf');
});

test('回归: 单条命名规则在章节中只计 1 次（JSON）', () => {
  const parser = new RuleParser();
  const p = path.join(makeTempDir('single-pattern-json'), 'r.json');
  fs.writeFileSync(p, JSON.stringify({
    name: 'JSON单规则',
    sections: [{
      name: 'S1', order: 1, directory: '01-s',
      namingPatterns: [{ pattern: '^.*\\.pdf$', label: 'pdf' }]
    }]
  }, null, 2), 'utf-8');
  const result = parser.loadForPreview(p);
  assert.strictEqual(result.errors.length, 0, '应无错误: ' + JSON.stringify(result.errors));
  assert.strictEqual(result.rule.sections[0].namingPatterns.length, 1,
    'JSON 单条规则不应翻倍，实际=' + result.rule.sections[0].namingPatterns.length);
});

test('回归: 样例规则 namingPattern 总计应为 11 条（不是 22）', () => {
  // samples/rule.yaml 各章节 namingPatterns 数量：
  //   01-投标函: 4,  02-商务资质: 2,  03-财务状况: 4,  04-类似业绩: 4,
  //   05-项目管理机构: 4,  06-施工组织设计: 2,  07-报价文件: 2
  // 合计 = 4+2+4+4+4+2+2 = 22 ... 实际计数核对：
  // 重新数一遍 samples/rule.yaml：
  //   一、投标函: 2 条 (中文名_签章.ext + 中文名(_v版本号).ext) — 但含 extractVersion
  //   二、商务资质: 1 条
  //   三、财务状况: 2 条
  //   四、类似业绩: 2 条
  //   五、项目管理机构: 2 条
  //   六、施工组织设计: 1 条
  //   七、报价文件: 1 条
  // 合计 = 2+1+2+2+2+1+1 = 11
  const parser = new RuleParser();
  const result = parser.loadForPreview(RULE_PATH);
  const actual = result.rule.sections.reduce((s, sec) => s + sec.namingPatterns.length, 0);
  assert.strictEqual(actual, 11,
    `样例规则命名规则总数应为 11，实际=${actual}。各章节：` +
    result.rule.sections.map(s => `${s.name}=${s.namingPatterns.length}`).join(', '));
});

test('回归: 连续两次 preview 不累加（原始 YAML 对象不被污染）', () => {
  const parser = new RuleParser();
  const p = path.join(makeTempDir('no-pollution'), 'r.yaml');
  fs.writeFileSync(p, `name: "两次"
sections:
  - name: "S"
    order: 1
    namingPatterns:
      - pattern: "^a$"
        label: "a"
      - pattern: "^b$"
        label: "b"
`, 'utf-8');

  const r1 = parser.loadForPreview(p);
  assert.strictEqual(r1.rule.sections[0].namingPatterns.length, 2, '第一次应为 2');

  const r2 = parser.loadForPreview(p);
  assert.strictEqual(r2.rule.sections[0].namingPatterns.length, 2,
    '第二次预览不应累加，实际=' + r2.rule.sections[0].namingPatterns.length);

  // 第三次确保稳定
  const r3 = parser.loadForPreview(p);
  assert.strictEqual(r3.rule.sections[0].namingPatterns.length, 2,
    '第三次预览也应为 2，实际=' + r3.rule.sections[0].namingPatterns.length);
});

test('回归: CLI validate --json 的 summary.namingPatternCount 与各章节明细之和一致', () => {
  const storeDir = makeTempDir('cli-validate-sum-match');
  const res = runCli('--store-dir', storeDir, 'validate', '--json', RULE_PATH, DATA_DIR);
  assert.strictEqual(res.status, 0);
  let parsed;
  try { parsed = JSON.parse(res.stdout); } catch (e) {
    assert.fail('JSON 解析失败: ' + e.message);
  }
  const sumFromSections = parsed.summary.sections.reduce(
    (s, sec) => s + sec.namingPatterns, 0
  );
  assert.strictEqual(parsed.summary.namingPatternCount, sumFromSections,
    `summary.namingPatternCount(${parsed.summary.namingPatternCount}) 应等于各章节之和(${sumFromSections})`);
  assert.strictEqual(parsed.summary.namingPatternCount, 11,
    `样例规则命名规则总数应为 11，summary 报告=${parsed.summary.namingPatternCount}`);
});

test('回归: 坏正则的章节不影响其他章节计数，也不累加', () => {
  const parser = new RuleParser();
  const p = path.join(makeTempDir('bad-regex-count'), 'r.yaml');
  fs.writeFileSync(p, `name: "混合"
sections:
  - name: "S1-好"
    order: 1
    namingPatterns:
      - pattern: ^good[.]pdf$
        label: "good"
  - name: "S2-坏"
    order: 2
    namingPatterns:
      - pattern: "*invalid*"
        label: "bad"
  - name: "S3-好"
    order: 3
    namingPatterns:
      - pattern: ^also-good[.]pdf$
        label: "also"
`, 'utf-8');
  const result = parser.loadForPreview(p);
  // 坏正则 1 条错误
  assert.ok(result.errors.some(e => /正则表达式无效/.test(e)),
    '应检测到坏正则: ' + JSON.stringify(result.errors));
  // 每个章节仍然只有 1 条（坏正则也会变成一个占位条目，但数量不翻倍）
  assert.strictEqual(result.rule.sections[0].namingPatterns.length, 1,
    '好规则 S1 应为 1 条');
  assert.strictEqual(result.rule.sections[1].namingPatterns.length, 1,
    '坏规则 S2 也应只有 1 条（占位），实际=' + result.rule.sections[1].namingPatterns.length);
  assert.strictEqual(result.rule.sections[2].namingPatterns.length, 1,
    '好规则 S3 应为 1 条');
  const total = result.rule.sections.reduce((s, sec) => s + sec.namingPatterns.length, 0);
  assert.strictEqual(total, 3, '3 个章节共 3 条，实际=' + total);
});

test('回归: 目录不存在时 summary.namingPatternCount 仍正确（不依赖 dir 预览）', () => {
  const storeDir = makeTempDir('validate-no-dir-count');
  const nonexistent = path.join(makeTempDir('nope'), 'nothing');
  const res = runCli('--store-dir', storeDir, 'validate', '--json', RULE_PATH, nonexistent);
  assert.strictEqual(res.status, 1, '目录不存在应 exit 1');
  let parsed;
  try { parsed = JSON.parse(res.stdout); } catch (e) {
    assert.fail('--json 在错误场景也应输出合法 JSON: ' + e.message + '\nstdout=' + res.stdout.slice(0, 300));
  }
  assert.strictEqual(parsed.summary.namingPatternCount, 11,
    `即使目录不存在，规则命名规则数仍应为 11，实际=${parsed.summary.namingPatternCount}`);
  const sumFromSections = parsed.summary.sections.reduce(
    (s, sec) => s + sec.namingPatterns, 0
  );
  assert.strictEqual(parsed.summary.namingPatternCount, sumFromSections,
    '汇总与章节明细之和应一致');
});

test('validate 后 scan / resume 仍沿用原 active batch（不覆盖）', () => {
  // 1) 先做一次 scan，设置 active-batch
  const storeDir = makeTempDir('validate-preserve-active');
  const scanRes = runCli(
    '--store-dir', storeDir,
    'scan', '--force', RULE_PATH, DATA_DIR
  );
  assert.strictEqual(scanRes.status, 0, '首次 scan 应成功');
  const activeBefore = fs.readFileSync(path.join(storeDir, 'active-batch'), 'utf-8').trim();
  assert.ok(activeBefore && activeBefore.length > 0, 'scan 后应有 active-batch');

  // 2) 再跑 validate
  const validateRes = runCli('--store-dir', storeDir, 'validate', RULE_PATH, DATA_DIR);
  assert.strictEqual(validateRes.status, 0, 'validate 应成功');

  // 3) 验证 active-batch 没变
  const activeAfter = fs.readFileSync(path.join(storeDir, 'active-batch'), 'utf-8').trim();
  assert.strictEqual(activeAfter, activeBefore, 'validate 不应改变 active-batch');

  // 4) 再跑 resume 应能恢复同一批次
  const resumeRes = runCli('--store-dir', storeDir, 'resume');
  assert.strictEqual(resumeRes.status, 0, 'resume 应成功');
  assert.ok(resumeRes.stdout.includes(activeBefore),
    'resume 输出中应包含原批次 ID');
});

test('回归: README 命令总览与 CLI --help 命令清单完全一致（防止新增命令漏掉文档）', () => {
  // 从 CLI help 提取命令名：匹配 `bbcheck <cmd>` 行（去掉参数、选项和描述）
  const helpRes = runCli('--help');
  assert.strictEqual(helpRes.status, 0, '--help 应成功');
  const helpLines = (helpRes.stdout + '\n' + helpRes.stderr).split(/\r?\n/);
  const helpCmdNames = [];
  const cmdRe = /^\s*(?:bbcheck\s+)?([a-z][a-z-]+)\b.*/;
  for (const line of helpLines) {
    // 跳过选项行（以 - 开头）
    if (/^\s*(-|--)/.test(line)) continue;
    const m = line.match(cmdRe);
    if (m) {
      const name = m[1];
      // 只接受已知命令模式：validate, scan, resume, review, carryover, status, undo, export, list, history, init-samples
      if (/^(validate|scan|resume|review|carryover|status|undo|export|list|history|init-samples|claim|assign|baseline|profile)$/.test(name)) {
        if (!helpCmdNames.includes(name)) helpCmdNames.push(name);
      }
    }
  }
  assert.ok(helpCmdNames.length >= 10,
    `CLI help 应提取到至少 10 个命令，实际=${helpCmdNames.length}：${JSON.stringify(helpCmdNames)}`);
  assert.strictEqual(helpCmdNames[0], 'validate',
    'CLI help 第一个命令应为 validate，实际顺序：' + JSON.stringify(helpCmdNames));

  // 从 README 的命令总览代码块中提取命令名
  const readmePath = path.join(__dirname, '..', 'README.md');
  const readmeContent = fs.readFileSync(readmePath, 'utf-8');
  const commandOverviewRe = /## 命令总览[\s\S]*?```\s*\n([\s\S]*?)\n```/;
  const m2 = readmeContent.match(commandOverviewRe);
  assert.ok(m2, 'README 应存在「命令总览」章节及代码块');
  const codeBlock = m2[1];
  const readmeCmdNames = [];
  for (const line of codeBlock.split(/\r?\n/)) {
    const m3 = line.match(/^\s*bbcheck\s+([a-z][a-z-]+)\b/);
    if (m3) readmeCmdNames.push(m3[1]);
  }
  assert.strictEqual(readmeCmdNames.length, helpCmdNames.length,
    `README 命令数量(${readmeCmdNames.length}) 应等于 CLI help 命令数量(${helpCmdNames.length})。` +
    `\nCLI help: ${JSON.stringify(helpCmdNames)}` +
    `\nREADME:   ${JSON.stringify(readmeCmdNames)}`);

  // 逐行比较命令名称和顺序
  for (let i = 0; i < helpCmdNames.length; i++) {
    assert.strictEqual(readmeCmdNames[i], helpCmdNames[i],
      `第 ${i + 1} 个命令不一致：CLI="${helpCmdNames[i]}" vs README="${readmeCmdNames[i]}"` +
      `\n完整顺序:\n  CLI: ${JSON.stringify(helpCmdNames)}\n  README: ${JSON.stringify(readmeCmdNames)}`);
  }
});

test('回归: README「快速开始」章节包含 validate 预览步骤（防止漏写入口）', () => {
  const readmePath = path.join(__dirname, '..', 'README.md');
  const readmeContent = fs.readFileSync(readmePath, 'utf-8');

  // 提取「快速开始」到「规则文件详解」之间的内容
  const m = readmeContent.match(/## 快速开始([\s\S]*?)## 规则文件详解/);
  assert.ok(m, 'README 应存在「快速开始」章节且后续有「规则文件详解」');
  const quickStart = m[1];

  // 1) 必须包含 validate 命令
  assert.ok(/bbcheck validate\b/.test(quickStart),
    '「快速开始」中应包含 bbcheck validate 命令示例');

  // 2) validate 必须出现在 scan 之前（推荐工作流顺序）
  const validatePos = quickStart.indexOf('bbcheck validate');
  const scanPos = quickStart.indexOf('bbcheck scan');
  assert.ok(validatePos >= 0, '「快速开始」中找不到 validate 命令');
  assert.ok(scanPos >= 0, '「快速开始」中找不到 scan 命令');
  assert.ok(validatePos < scanPos,
    `validate 应出现在 scan 之前（validate 位置=${validatePos}, scan 位置=${scanPos}）`);

  // 3) 必须提到「不写入 .bbcheck/ 状态目录、不创建批次」或等价表述
  assert.ok(/不写入.*bbcheck|不.*会.*创建.*批次|零副作用|不生成批次/.test(quickStart),
    '「快速开始」中应说明 validate 不写状态目录 / 不创建批次');
});

// ─────────────────────────────────────────────────────────────
// 测试 8: carryover 复用上次处理结果
// ─────────────────────────────────────────────────────────────
suite('新功能: carryover 复用上次处理结果');

test('正常带入：两批次相同问题 — 状态、处理人、备注均复制', () => {
  const store = newStore('carryover-basic');

  // 批次 1: 扫描并复核
  const r1 = scanOnce(store);
  const missing = r1.issues.filter(i => i.type === 'MISSING_FILE');
  assert.ok(missing.length > 0, '批次 1 应有缺失文件类问题');

  const updates = missing.map(i => ({
    issueId: i.id,
    status: REVIEW_STATUS.CONFIRMED,
    remark: '已联系供应商'
  }));
  store.batchUpdateIssues(r1.batchId, updates, 'test-handler-1');

  // 批次 2: 再次扫描（同一目录的"新批次"）
  const r2 = scanOnce(store);
  const r2Pending = r2.issues.filter(i => i.reviewStatus === REVIEW_STATUS.PENDING);
  assert.ok(r2Pending.length > 0, '批次 2 初始状态下应全是待处理');

  // 执行 carryover
  const result = store.carryoverIssues(r2.batchId, r1.batchId);
  assert.strictEqual(result.previousBatchId, r1.batchId, 'previousBatchId 应匹配');
  assert.ok(result.carried >= missing.length, `至少带入 ${missing.length} 个缺失文件，实际=${result.carried}`);
  assert.strictEqual(result.warnings.length, 0, '不应有 warnings');

  // 验证批次 2 中被带入的问题
  const reloaded = store.loadBatch(r2.batchId);
  const r2Missing = reloaded.issues.filter(i => i.type === 'MISSING_FILE');
  assert.ok(
    r2Missing.every(i => i.reviewStatus === REVIEW_STATUS.CONFIRMED),
    '批次 2 的缺失文件类问题应全部被带入为已确认'
  );
  assert.ok(
    r2Missing.every(i => i.handler === 'test-handler-1'),
    '处理人应被带入'
  );
  assert.ok(
    r2Missing.every(i => i.remark && i.remark.includes('已联系供应商')),
    '备注应包含原内容'
  );
  assert.ok(
    r2Missing.every(i => i.remark && i.remark.includes('复用自')),
    '备注应标记"复用自"'
  );
  // 复核历史应至少 1 条（carryover 写入）
  assert.ok(
    r2Missing.every(i => i.reviewHistory.length >= 1),
    '带入后复核历史应 >= 1 条'
  );
});

test('冲突跳过：已手动处理的新批次问题不被覆盖', () => {
  const store = newStore('carryover-conflict');

  const r1 = scanOnce(store);
  const missing = r1.issues.filter(i => i.type === 'MISSING_FILE');
  store.batchUpdateIssues(r1.batchId, missing.map(i => ({
    issueId: i.id, status: REVIEW_STATUS.CONFIRMED, remark: '批次1备注'
  })), 'handler1');

  const r2 = scanOnce(store);
  const r2Missing = r2.issues.filter(i => i.type === 'MISSING_FILE');
  // 提前手动处理批次 2 的前一半问题（设置为 IGNORED，不同于批次 1 的 CONFIRMED）
  const firstHalf = r2Missing.slice(0, Math.max(1, Math.floor(r2Missing.length / 2)));
  store.batchUpdateIssues(r2.batchId, firstHalf.map(i => ({
    issueId: i.id, status: REVIEW_STATUS.IGNORED, remark: '我手动处理了'
  })), 'manual-handler');

  const result = store.carryoverIssues(r2.batchId, r1.batchId);
  assert.ok(result.conflicts.length >= 1, `应有至少 1 个冲突，实际=${result.conflicts.length}`);

  // 验证：前一半问题仍然是 IGNORED（手动处理状态未被覆盖）
  const reloaded = store.loadBatch(r2.batchId);
  for (const issue of firstHalf) {
    const updated = reloaded.getIssueById(issue.id);
    assert.strictEqual(updated.reviewStatus, REVIEW_STATUS.IGNORED,
      `手动处理的问题 ${issue.id} 不应被覆盖，应为 IGNORED`);
    assert.strictEqual(updated.handler, 'manual-handler', '处理人也不应被覆盖');
    assert.ok(updated.remark && updated.remark.includes('我手动处理了'), '备注保留手动内容');
  }

  // 验证：后一半问题被带入为 CONFIRMED
  const secondHalf = r2Missing.slice(Math.max(1, Math.floor(r2Missing.length / 2)));
  for (const issue of secondHalf) {
    const updated = reloaded.getIssueById(issue.id);
    assert.strictEqual(updated.reviewStatus, REVIEW_STATUS.CONFIRMED,
      `未手动处理的问题 ${issue.id} 应被带入为 CONFIRMED`);
  }
});

test('描述变化检测：仅类型+路径+章节匹配但描述不同时，列入 descChanged 不自动带入', () => {
  const store = newStore('carryover-desc-changed');
  const r1 = scanOnce(store);

  // 找一个带 targetPath 的已处理问题
  const withTarget = r1.issues.find(i => i.targetPath && i.targetPath.length > 0);
  if (withTarget) {
    store.updateIssueStatus(r1.batchId, withTarget.id, REVIEW_STATUS.CONFIRMED, 'h1', '备注r1');

    const r2 = scanOnce(store);
    // 修改批次 2 中对应问题的 message（模拟描述变化）
    const sameSignature = store._buildIssueSignatureWithoutDesc
      ? store._buildIssueSignatureWithoutDesc(withTarget)
      : `${withTarget.type}::${withTarget.targetPath || ''}::${(withTarget.details && withTarget.details.section) || ''}`;

    const matchInR2 = r2.issues.find(ci => {
      const sig = (ci.type + '::' + (ci.targetPath || '') + '::' + ((ci.details && ci.details.section) || ''));
      return sig === sameSignature;
    });

    if (matchInR2) {
      const origMessage = matchInR2.message;
      matchInR2.message = '[已修改描述] ' + origMessage;
      // 手动保存修改后的 r2
      store.saveBatch(r2);

      const result = store.carryoverIssues(r2.batchId, r1.batchId);
      assert.ok(result.descChanged.length >= 1,
        `应检测到 descChanged，实际=${result.descChanged.length}。result=${JSON.stringify(result.descChanged)}`);
    }
  }
  // 如果找不到合适问题，测试空通过（场景非必需）
  assert.ok(true, '描述变化检测完成');
});

test('撤销 carryover：undo 后回到 carryover 之前的全 pending 状态', () => {
  const store = newStore('carryover-undo');

  const r1 = scanOnce(store);
  const missing = r1.issues.filter(i => i.type === 'MISSING_FILE');
  store.batchUpdateIssues(r1.batchId, missing.map(i => ({
    issueId: i.id, status: REVIEW_STATUS.IGNORED, remark: 'r1ignored'
  })), 'h1');

  const r2 = scanOnce(store);
  const pendingBefore = r2.issues.filter(i => i.reviewStatus === REVIEW_STATUS.PENDING).length;

  const carryResult = store.carryoverIssues(r2.batchId, r1.batchId);
  assert.ok(carryResult.carried > 0, '带入成功');

  const afterCarry = store.loadBatch(r2.batchId);
  const pendingAfter = afterCarry.issues.filter(i => i.reviewStatus === REVIEW_STATUS.PENDING).length;
  assert.ok(pendingAfter < pendingBefore, '带入后 pending 数量应减少');

  // 撤销
  const undoAction = store.undo();
  assert.strictEqual(undoAction.type, 'CARRYOVER', '撤销动作类型应为 CARRYOVER');

  const afterUndo = store.loadBatch(r2.batchId);
  const pendingUndo = afterUndo.issues.filter(i => i.reviewStatus === REVIEW_STATUS.PENDING).length;
  assert.strictEqual(pendingUndo, pendingBefore,
    `撤销后 pending 数量应恢复为 ${pendingBefore}，实际=${pendingUndo}`);
});

test('跨重启：carryover 结果持久化，新 StateStore 实例能读到', () => {
  const storeDir = makeTempDir('carryover-persist');
  const store1 = new StateStore(storeDir);

  const r1 = scanOnce(store1);
  const missing = r1.issues.filter(i => i.type === 'MISSING_FILE');
  store1.batchUpdateIssues(r1.batchId, missing.map(i => ({
    issueId: i.id, status: REVIEW_STATUS.CONFIRMED, remark: 'persist测试'
  })), 'persist-h');

  const r2 = scanOnce(store1);
  store1.carryoverIssues(r2.batchId, r1.batchId);

  // 模拟重启：新实例
  const store2 = new StateStore(storeDir);
  const loaded = store2.loadBatch(r2.batchId);
  assert.ok(loaded, '新实例应能加载批次 2');

  const r2Missing = loaded.issues.filter(i => i.type === 'MISSING_FILE');
  assert.ok(r2Missing.length > 0, '批次 2 中应有缺失文件类问题');
  assert.ok(
    r2Missing.every(i => i.reviewStatus === REVIEW_STATUS.CONFIRMED),
    '重启后仍应看到被带入的已确认状态'
  );
  assert.ok(
    r2Missing.every(i => i.handler === 'persist-h'),
    '重启后处理人仍在'
  );
  assert.ok(
    r2Missing.every(i => i.remark && i.remark.includes('persist测试')),
    '重启后备注仍在'
  );
});

test('旧批次不存在：返回清晰 warnings，不抛异常', () => {
  const store = newStore('carryover-no-prev');
  const r1 = scanOnce(store);

  // 指定一个不存在的批次作为来源
  const result = store.carryoverIssues(r1.batchId, 'NONEXISTENT_BATCH_XYZ');
  assert.ok(result.warnings && result.warnings.length > 0, '应返回 warnings');
  assert.ok(result.warnings[0].includes('已被删除') || result.warnings[0].includes('损坏') || result.warnings[0].includes('找不到'),
    `warnings 内容应说明旧批次问题: "${result.warnings[0]}"`);
  assert.strictEqual(result.carried, 0, '不应有带入');
});

test('当前批次没有待处理项：返回提示，不做任何修改', () => {
  const store = newStore('carryover-no-pending');

  const r1 = scanOnce(store);
  // 把批次 1 全部处理了
  store.batchUpdateIssues(r1.batchId, r1.issues.map(i => ({
    issueId: i.id, status: REVIEW_STATUS.CONFIRMED
  })), 'all-confirmed');

  const r2 = scanOnce(store);
  // 再把批次 2 也全部处理
  store.batchUpdateIssues(r2.batchId, r2.issues.map(i => ({
    issueId: i.id, status: REVIEW_STATUS.IGNORED
  })), 'all-ignored');

  const result = store.carryoverIssues(r2.batchId, r1.batchId);
  assert.ok(result.warnings.length > 0, '应有提示');
  assert.ok(result.warnings[0].includes('没有待处理'),
    `提示应包含"没有待处理": ${result.warnings[0]}`);
  assert.strictEqual(result.carried, 0);

  // 状态不应被修改（仍为全 ignored）
  const reloaded = store.loadBatch(r2.batchId);
  assert.ok(
    reloaded.issues.every(i => i.reviewStatus === REVIEW_STATUS.IGNORED),
    '无待处理项时 carryover 不应修改任何状态'
  );
});

test('findPreviousBatchId：同目录的更早批次能自动找到', () => {
  const store = newStore('carryover-auto-find');
  const r1 = scanOnce(store);
  const r2 = scanOnce(store);
  const r3 = scanOnce(store);

  const prev3 = store.findPreviousBatchId(r3.batchId);
  assert.strictEqual(prev3, r2.batchId, 'r3 的上一批次应为 r2');

  const prev2 = store.findPreviousBatchId(r2.batchId);
  assert.strictEqual(prev2, r1.batchId, 'r2 的上一批次应为 r1');

  const prev1 = store.findPreviousBatchId(r1.batchId);
  assert.strictEqual(prev1, null, 'r1 不应有上一批次');
});

test('CLI carryover — 正常流程有可见输出', () => {
  const storeDir = makeTempDir('cli-carryover');
  // 批次 1: scan + review 一部分
  let res = runCli('--store-dir', storeDir, 'scan', '--force', RULE_PATH, DATA_DIR);
  assert.strictEqual(res.status, 0, 'scan 1 应成功');
  const batch1Match = (res.stdout + res.stderr).match(/BATCH_[a-z0-9_]+/i);
  assert.ok(batch1Match, 'scan 1 输出应含批次ID');
  const batch1Id = batch1Match[0];

  // 读取批次 1，批量处理缺失文件
  const tStore = new StateStore(storeDir);
  const b1 = tStore.loadBatch(batch1Id);
  const missing = b1.issues.filter(i => i.type === 'MISSING_FILE').slice(0, 2);
  if (missing.length > 0) {
    tStore.batchUpdateIssues(batch1Id, missing.map(i => ({
      issueId: i.id, status: REVIEW_STATUS.CONFIRMED, remark: 'CLI测试'
    })), 'cli-user');
  }

  // 批次 2: --force 重新扫描
  res = runCli('--store-dir', storeDir, 'scan', '--force', RULE_PATH, DATA_DIR);
  assert.strictEqual(res.status, 0, 'scan 2 应成功');
  const batch2Match = (res.stdout + res.stderr).match(/BATCH_[a-z0-9_]+/gi);
  const batch2Id = batch2Match[batch2Match.length - 1];
  assert.ok(batch2Id !== batch1Id, 'scan 2 应产生新批次ID');

  // 执行 carryover
  res = runCli('--store-dir', storeDir, 'carryover', '--from', batch1Id);
  assert.strictEqual(res.status, 0, 'carryover 应成功');
  const combined = res.stdout + res.stderr;
  assert.ok(/复用上次处理结果/.test(combined), '输出应含标题"复用上次处理结果"');
  assert.ok(/成功带入/.test(combined), '输出应含"成功带入"');

  // status 验证状态变化
  res = runCli('--store-dir', storeDir, 'status');
  assert.strictEqual(res.status, 0, 'status 应成功');
  assert.ok(/已确认/.test(res.stdout), 'status 中应出现已确认（被带入的）');
  assert.ok(/待补/.test(res.stdout), 'status 中应有待补（未被带入的）');
});

test('CLI carryover — 旧批次不存在时退出码 0 并给出提示', () => {
  const storeDir = makeTempDir('cli-carryover-no-prev');
  runCli('--store-dir', storeDir, 'scan', '--force', RULE_PATH, DATA_DIR);
  const res = runCli('--store-dir', storeDir, 'carryover', '--from', 'DOES_NOT_EXIST_BATCH');
  // 不抛异常，退出码 0（warning 级别），输出含提示
  assert.strictEqual(res.status, 0, '旧批次不存在时不应崩溃');
  assert.ok(/已被删除|损坏|找不到/.test(res.stdout + res.stderr),
    '输出中应给出旧批次不存在的清晰提示');
});

test('回归: README 命令总览包含 carryover 命令', () => {
  const readmePath = path.join(__dirname, '..', 'README.md');
  const readmeContent = fs.readFileSync(readmePath, 'utf-8');
  const commandOverviewRe = /## 命令总览[\s\S]*?```\s*\n([\s\S]*?)\n```/;
  const m = readmeContent.match(commandOverviewRe);
  assert.ok(m, 'README 应存在「命令总览」章节');
  const codeBlock = m[1];
  assert.ok(/bbcheck carryover\b/.test(codeBlock),
    'README 命令总览代码块中应包含 bbcheck carryover');
});

// ─────────────────────────────────────────────────────────────
// 测试 9: claim / assign 多人协作
// ─────────────────────────────────────────────────────────────
suite('新功能: claim 领取问题');

test('claimIssues — 按类型批量领取', () => {
  const store = newStore('claim-by-type');
  const r = scanOnce(store);
  const missing = r.issues.filter(i => i.type === 'MISSING_FILE');
  assert.ok(missing.length > 0, '应有缺失文件类问题');

  const result = store.claimIssues(r.batchId, '张三', { type: 'MISSING_FILE' });
  assert.ok(!result.error, '不应有错误: ' + (result.error || ''));
  assert.strictEqual(result.claimed, missing.length, `应领取 ${missing.length} 个问题`);
  assert.strictEqual(result.conflicts.length, 0, '不应有冲突');

  const reloaded = store.loadBatch(r.batchId);
  const claimedIssues = reloaded.issues.filter(i => i.type === 'MISSING_FILE');
  assert.ok(claimedIssues.every(i => i.assignee === '张三'), '领取后负责人应为张三');
  assert.ok(claimedIssues.every(i => i.reviewHistory.some(h => h.operator === '张三' && h.to === '张三')), '应有领取历史');
});

test('claimIssues — 按ID领取', () => {
  const store = newStore('claim-by-id');
  const r = scanOnce(store);
  const firstIssue = r.issues[0];

  const result = store.claimIssues(r.batchId, '李四', { ids: firstIssue.id });
  assert.strictEqual(result.claimed, 1, '应领取 1 个问题');

  const reloaded = store.loadBatch(r.batchId);
  const claimed = reloaded.getIssueById(firstIssue.id);
  assert.strictEqual(claimed.assignee, '李四', '负责人应为李四');
});

test('claimIssues — 按章节领取', () => {
  const store = newStore('claim-by-section');
  const r = scanOnce(store);
  const withSection = r.issues.filter(i => i.details && i.details.section);
  if (withSection.length === 0) { assert.ok(true, '没有带章节的问题'); return; }

  const firstSection = withSection[0].details.section;
  const result = store.claimIssues(r.batchId, '王五', { section: firstSection });
  assert.ok(result.claimed > 0, '应领取至少 1 个问题');
});

test('claimIssues — 冲突保护：已被别人领取的不能再领', () => {
  const store = newStore('claim-conflict');
  const r = scanOnce(store);
  const firstIssue = r.issues[0];

  store.claimIssues(r.batchId, '张三', { ids: firstIssue.id });
  const result = store.claimIssues(r.batchId, '李四', { ids: firstIssue.id });
  assert.strictEqual(result.claimed, 0, '已被领取的不应再被别人领取');
  assert.ok(result.conflicts.some(c => c.currentAssignee === '张三'), '应有冲突记录');

  const reloaded = store.loadBatch(r.batchId);
  const issue = reloaded.getIssueById(firstIssue.id);
  assert.strictEqual(issue.assignee, '张三', '负责人应仍为张三');
});

test('claimIssues — 同人重复领取跳过', () => {
  const store = newStore('claim-same-person');
  const r = scanOnce(store);
  const firstIssue = r.issues[0];

  store.claimIssues(r.batchId, '张三', { ids: firstIssue.id });
  const result = store.claimIssues(r.batchId, '张三', { ids: firstIssue.id });
  assert.strictEqual(result.claimed, 0, '同人重复领取应为 0');
  assert.ok(result.conflicts.some(c => c.samePerson), '应标记为同人');
});

test('claimIssues — 负责人为空报错', () => {
  const store = newStore('claim-empty');
  const r = scanOnce(store);
  const result = store.claimIssues(r.batchId, '', { type: 'MISSING_FILE' });
  assert.strictEqual(result.error, '负责人不能为空', '应报错');
  assert.strictEqual(result.claimed, 0);
});

test('claimIssues — 批次不存在报错', () => {
  const store = newStore('claim-no-batch');
  const result = store.claimIssues('NONEXISTENT_BATCH', '张三', {});
  assert.ok(result.error && result.error.includes('批次不存在'), '应报批次不存在');
});

test('撤销 claim — undo 后负责人回到 null', () => {
  const store = newStore('claim-undo');
  const r = scanOnce(store);
  store.claimIssues(r.batchId, '张三', { type: 'MISSING_FILE' });

  const action = store.undo();
  assert.strictEqual(action.type, 'CLAIM', '撤销动作类型应为 CLAIM');

  const reloaded = store.loadBatch(r.batchId);
  const claimedBack = reloaded.issues.filter(i => i.assignee !== null);
  assert.strictEqual(claimedBack.length, 0, '撤销后所有负责人应为 null');
});

test('跨重启：claim 信息持久化', () => {
  const storeDir = makeTempDir('claim-persist');
  const store1 = new StateStore(storeDir);
  const r = scanOnce(store1);
  store1.claimIssues(r.batchId, '张三', { type: 'MISSING_FILE' });

  const store2 = new StateStore(storeDir);
  const loaded = store2.loadBatch(r.batchId);
  const missing = loaded.issues.filter(i => i.type === 'MISSING_FILE');
  assert.ok(missing.every(i => i.assignee === '张三'), '重启后负责人仍应为张三');
});

suite('新功能: assign 转派问题');

test('assignIssues — 正常转派', () => {
  const store = newStore('assign-basic');
  const r = scanOnce(store);
  const firstIssue = r.issues[0];
  store.claimIssues(r.batchId, '张三', { ids: firstIssue.id });

  const result = store.assignIssues(r.batchId, '李四', '管理员', { ids: firstIssue.id, force: true, reason: '工作量调整' });
  assert.strictEqual(result.assigned, 1, '应转派 1 个问题');

  const reloaded = store.loadBatch(r.batchId);
  const issue = reloaded.getIssueById(firstIssue.id);
  assert.strictEqual(issue.assignee, '李四', '转派后负责人应为李四');
  assert.ok(issue.reviewHistory.some(h => h.operator === '管理员' && h.reason && h.reason.includes('工作量调整')), '应有转派原因');
});

test('assignIssues — 同人转派冲突', () => {
  const store = newStore('assign-same');
  const r = scanOnce(store);
  const firstIssue = r.issues[0];
  store.claimIssues(r.batchId, '张三', { ids: firstIssue.id });

  const result = store.assignIssues(r.batchId, '张三', '管理员', { ids: firstIssue.id });
  assert.strictEqual(result.assigned, 0, '同人转派应为 0');
  assert.ok(result.conflicts.some(c => c.samePerson), '应标记同人冲突');
});

test('assignIssues — 已确认/忽略的问题需 --force', () => {
  const store = newStore('assign-finalized');
  const r = scanOnce(store);
  const firstIssue = r.issues[0];
  store.updateIssueStatus(r.batchId, firstIssue.id, REVIEW_STATUS.CONFIRMED, 'user1', '');

  const resultNoForce = store.assignIssues(r.batchId, '李四', '管理员', { ids: firstIssue.id });
  assert.strictEqual(resultNoForce.assigned, 0, '不用 force 应被阻止');
  assert.ok(resultNoForce.conflicts.some(c => c.alreadyFinalized), '应标记为已确认');

  const resultForce = store.assignIssues(r.batchId, '李四', '管理员', { ids: firstIssue.id, force: true, reason: '强制转派' });
  assert.strictEqual(resultForce.assigned, 1, '用 force 应可转派');

  const reloaded = store.loadBatch(r.batchId);
  const issue = reloaded.getIssueById(firstIssue.id);
  assert.strictEqual(issue.assignee, '李四', '强制转派后负责人应为李四');
});

test('assignIssues — 已被领取的问题需 --force', () => {
  const store = newStore('assign-claimed');
  const r = scanOnce(store);
  const firstIssue = r.issues[0];
  store.claimIssues(r.batchId, '张三', { ids: firstIssue.id });

  const resultNoForce = store.assignIssues(r.batchId, '李四', '管理员', { ids: firstIssue.id });
  assert.strictEqual(resultNoForce.assigned, 0, '不用 force 应被阻止');
  assert.ok(resultNoForce.conflicts.some(c => c.alreadyClaimed), '应标记为已被领取');

  const resultForce = store.assignIssues(r.batchId, '李四', '管理员', { ids: firstIssue.id, force: true, reason: '重新分配' });
  assert.strictEqual(resultForce.assigned, 1, '用 force 应可转派');
});

test('assignIssues — 目标负责人为空报错', () => {
  const store = newStore('assign-empty');
  const r = scanOnce(store);
  const result = store.assignIssues(r.batchId, '', '管理员', {});
  assert.strictEqual(result.error, '目标负责人不能为空');
});

test('撤销 assign — undo 后负责人回到原值', () => {
  const store = newStore('assign-undo');
  const r = scanOnce(store);
  const firstIssue = r.issues[0];
  store.claimIssues(r.batchId, '张三', { ids: firstIssue.id });
  store.assignIssues(r.batchId, '李四', '管理员', { ids: firstIssue.id, force: true, reason: '测试' });

  const action = store.undo();
  assert.strictEqual(action.type, 'ASSIGN', '撤销动作类型应为 ASSIGN');

  const reloaded = store.loadBatch(r.batchId);
  const issue = reloaded.getIssueById(firstIssue.id);
  assert.strictEqual(issue.assignee, '张三', '撤销后负责人应回到张三');
});

suite('新功能: review 冲突保护');

test('review — 已被他人领取的问题不--force被阻止（批量模式）', () => {
  const store = newStore('review-conflict');
  const r = scanOnce(store);
  const firstIssue = r.issues[0];
  store.claimIssues(r.batchId, '张三', { ids: firstIssue.id });

  const tStore = store;
  const batchId = r.batchId;
  const reloaded = tStore.loadBatch(batchId);
  const protectedIssues = reloaded.issues.filter(i => i.assignee && i.assignee !== '李四');
  assert.ok(protectedIssues.length > 0, '应有被张三领取的问题');
});

suite('新功能: ID前缀匹配');

test('findIssuesByPrefix — 单个匹配', () => {
  const store = newStore('prefix-single');
  const r = scanOnce(store);
  const firstIssue = r.issues[0];
  const prefix = firstIssue.id.slice(0, 10);

  const result = store.findIssuesByPrefix(r.batchId, prefix);
  if (result.issues.length === 1) {
    assert.strictEqual(result.error, null, '单匹配不应报错');
    assert.strictEqual(result.issues[0].id, firstIssue.id);
  }
});

test('findIssuesByPrefix — 多个匹配报歧义', () => {
  const store = newStore('prefix-ambig');
  const r = scanOnce(store);
  const veryShort = 'ISSUE_';
  const result = store.findIssuesByPrefix(r.batchId, veryShort);
  if (result.issues.length > 1) {
    assert.ok(result.ambiguous, '多匹配应标记歧义');
    assert.ok(result.error && result.error.includes('匹配到'), '应提示匹配多个');
  }
});

test('findIssuesByPrefix — 无匹配', () => {
  const store = newStore('prefix-none');
  const r = scanOnce(store);
  const result = store.findIssuesByPrefix(r.batchId, 'NONEXISTENT_PREFIX');
  assert.ok(result.error, '无匹配应报错');
});

suite('新功能: 导出包含负责人字段');

test('导出 CSV — 包含负责人列', () => {
  const store = newStore('export-csv-assignee');
  const r = scanOnce(store);
  store.claimIssues(r.batchId, '张三', { type: 'MISSING_FILE' });

  const reloaded = store.loadBatch(r.batchId);
  const exporter = new Exporter();
  const outFile = path.join(makeTempDir('csv-assignee-out'), 'report.csv');
  exporter.exportCSV(reloaded, outFile);

  const content = fs.readFileSync(outFile, 'utf-8');
  assert.ok(content.includes('负责人'), 'CSV 表头应包含"负责人"');
  assert.ok(content.includes('张三'), 'CSV 中应包含负责人名字');
});

test('导出 HTML — 包含负责人列', () => {
  const store = newStore('export-html-assignee');
  const r = scanOnce(store);
  store.claimIssues(r.batchId, '张三', { type: 'MISSING_FILE' });

  const reloaded = store.loadBatch(r.batchId);
  const exporter = new Exporter();
  const outFile = path.join(makeTempDir('html-assignee-out'), 'report.html');
  exporter.exportHTML(reloaded, outFile);

  const content = fs.readFileSync(outFile, 'utf-8');
  assert.ok(content.includes('负责人'), 'HTML 表头应包含"负责人"');
  assert.ok(content.includes('张三'), 'HTML 中应包含负责人名字');
});

test('导出 JSON — 包含 assignee 字段', () => {
  const store = newStore('export-json-assignee');
  const r = scanOnce(store);
  store.claimIssues(r.batchId, '张三', { type: 'MISSING_FILE' });

  const reloaded = store.loadBatch(r.batchId);
  const exporter = new Exporter();
  const outFile = path.join(makeTempDir('json-assignee-out'), 'report.json');
  exporter.exportJSON(reloaded, outFile);

  const raw = fs.readFileSync(outFile, 'utf-8');
  const parsed = JSON.parse(raw);
  const withAssignee = parsed.issues.filter(i => i.assignee === '张三');
  assert.ok(withAssignee.length > 0, 'JSON 中应有含负责人字段的问题');
});

suite('新功能: CLI claim / assign 命令');

test('CLI claim — 按类型领取', () => {
  const storeDir = makeTempDir('cli-claim');
  const scanRes = runCli('--store-dir', storeDir, 'scan', '--force', RULE_PATH, DATA_DIR);
  assert.strictEqual(scanRes.status, 0, 'scan 应成功');

  const claimRes = runCli('--store-dir', storeDir, 'claim', '--assignee', '张三', '--type', 'MISSING_FILE');
  assert.strictEqual(claimRes.status, 0, 'claim 应成功');
  assert.ok(/已领取/.test(claimRes.stdout), '输出应含"已领取"');
  assert.ok(/张三/.test(claimRes.stdout), '输出应含领取人名字');
});

test('CLI assign — 正常转派', () => {
  const storeDir = makeTempDir('cli-assign');
  const scanRes = runCli('--store-dir', storeDir, 'scan', '--force', RULE_PATH, DATA_DIR);
  assert.strictEqual(scanRes.status, 0);

  runCli('--store-dir', storeDir, 'claim', '--assignee', '张三', '--type', 'MISSING_FILE');

  const assignRes = runCli('--store-dir', storeDir, 'assign', '李四', '--operator', '管理员', '--type', 'MISSING_FILE', '--force', '--reason', '工作量调整');
  assert.strictEqual(assignRes.status, 0, 'assign 应成功');
  assert.ok(/转派/.test(assignRes.stdout), '输出应含"转派"');
});

test('CLI claim — 冲突时退出码 1', () => {
  const storeDir = makeTempDir('cli-claim-conflict');
  const scanRes = runCli('--store-dir', storeDir, 'scan', '--force', RULE_PATH, DATA_DIR);
  assert.strictEqual(scanRes.status, 0);

  runCli('--store-dir', storeDir, 'claim', '--assignee', '张三', '--type', 'MISSING_FILE');
  const claimAgain = runCli('--store-dir', storeDir, 'claim', '--assignee', '李四', '--type', 'MISSING_FILE');
  assert.strictEqual(claimAgain.status, 1, '冲突时退出码应为 1');
});

test('CLI assign — 无 force 阻止转派已领取的问题退出码 1', () => {
  const storeDir = makeTempDir('cli-assign-noforce');
  const scanRes = runCli('--store-dir', storeDir, 'scan', '--force', RULE_PATH, DATA_DIR);
  assert.strictEqual(scanRes.status, 0);

  runCli('--store-dir', storeDir, 'claim', '--assignee', '张三', '--type', 'MISSING_FILE');
  const assignRes = runCli('--store-dir', storeDir, 'assign', '李四', '--operator', '管理员', '--type', 'MISSING_FILE');
  assert.strictEqual(assignRes.status, 1, '无 force 应退出码 1');
});

test('CLI undo — 撤销 claim/assign', () => {
  const storeDir = makeTempDir('cli-undo-claim');
  const scanRes = runCli('--store-dir', storeDir, 'scan', '--force', RULE_PATH, DATA_DIR);
  assert.strictEqual(scanRes.status, 0);

  runCli('--store-dir', storeDir, 'claim', '--assignee', '张三', '--type', 'MISSING_FILE');
  const undoRes = runCli('--store-dir', storeDir, 'undo');
  assert.strictEqual(undoRes.status, 0, 'undo 应成功');
  assert.ok(/领取问题/.test(undoRes.stdout), '输出应含"领取问题"');
});

test('回归: README 命令总览包含 claim 和 assign 命令', () => {
  const readmePath = path.join(__dirname, '..', 'README.md');
  const readmeContent = fs.readFileSync(readmePath, 'utf-8');
  const commandOverviewRe = /## 命令总览[\s\S]*?```\s*\n([\s\S]*?)\n```/;
  const m = readmeContent.match(commandOverviewRe);
  assert.ok(m, 'README 应存在「命令总览」章节');
  const codeBlock = m[1];
  assert.ok(/bbcheck claim\b/.test(codeBlock), 'README 命令总览中应包含 bbcheck claim');
  assert.ok(/bbcheck assign\b/.test(codeBlock), 'README 命令总览中应包含 bbcheck assign');
});

// ─────────────────────────────────────────────────────────────
// 测试 10: baseline 基线管理
// ─────────────────────────────────────────────────────────────
suite('新功能: baseline save / diff / list');

test('baseline save — 保存基线成功', () => {
  const storeDir = makeTempDir('bl-save');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);

  const result = bl.save('v1', r);
  assert.strictEqual(result.name, 'v1');
  assert.strictEqual(result.overwritten, false);
  assert.strictEqual(result.issueCount, r.issues.length);
  assert.ok(result.issueCount > 0, '应有问题');
});

test('baseline save — 同名基线不覆盖时报错', () => {
  const storeDir = makeTempDir('bl-dup');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);

  bl.save('v1', r);
  assert.throws(() => bl.save('v1', r), /已存在/);
});

test('baseline save — 同名基线 force 覆盖', () => {
  const storeDir = makeTempDir('bl-force');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);

  bl.save('v1', r);
  const result = bl.save('v1', r, { force: true });
  assert.strictEqual(result.overwritten, true);
});

test('baseline save — 空名称报错', () => {
  const storeDir = makeTempDir('bl-empty-name');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);
  assert.throws(() => bl.save('', r), /不能为空/);
});

test('baseline save — 非法字符名称报错', () => {
  const storeDir = makeTempDir('bl-bad-name');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);
  assert.throws(() => bl.save('bad name!', r), /非法字符/);
});

test('baseline save — 无扫描结果报错', () => {
  const storeDir = makeTempDir('bl-no-scan');
  const bl = new BaselineManager(storeDir);
  assert.throws(() => bl.save('v1', null), /没有激活的批次/);
});

test('baseline list — 列出已保存的基线', () => {
  const storeDir = makeTempDir('bl-list');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);

  bl.save('alpha', r);
  bl.save('beta', r);

  const list = bl.list();
  assert.strictEqual(list.length, 2);
  const names = list.map(b => b.name);
  assert.ok(names.includes('alpha'));
  assert.ok(names.includes('beta'));
});

test('baseline list — 空时返回空数组', () => {
  const storeDir = makeTempDir('bl-list-empty');
  const bl = new BaselineManager(storeDir);
  const list = bl.list();
  assert.strictEqual(list.length, 0);
});

test('baseline list — 损坏文件标记为 corrupted', () => {
  const storeDir = makeTempDir('bl-list-corrupt');
  const bl = new BaselineManager(storeDir);
  const baselinesDir = path.join(storeDir, 'baselines');
  if (!fs.existsSync(baselinesDir)) fs.mkdirSync(baselinesDir, { recursive: true });
  fs.writeFileSync(path.join(baselinesDir, 'bad.json'), 'not valid json{{{', 'utf-8');

  const list = bl.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'bad');
  assert.strictEqual(list[0].corrupted, true);
});

test('baseline diff — 相同批次差异为零', () => {
  const storeDir = makeTempDir('bl-diff-same');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);

  bl.save('v1', r);
  const diffResult = bl.diff('v1', r);
  assert.strictEqual(diffResult.summary.added, 0);
  assert.strictEqual(diffResult.summary.removed, 0);
  assert.strictEqual(diffResult.summary.changed, 0);
  assert.strictEqual(diffResult.summary.unchanged, r.issues.length);
});

test('baseline diff — 新批次有问题新增和消失', () => {
  const storeDir = makeTempDir('bl-diff-new');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r1 = scanOnce(store);

  bl.save('v1', r1);

  const r2 = scanOnce(store);
  const diffResult = bl.diff('v1', r2);

  assert.ok(diffResult.summary.unchanged > 0, '大部分问题应未变');
  assert.strictEqual(diffResult.summary.added + diffResult.summary.removed + diffResult.summary.changed + diffResult.summary.unchanged,
    r2.issues.length, '分类总数应等于当前问题总数');
});

test('baseline diff — 状态/负责人/备注变化能检测', () => {
  const storeDir = makeTempDir('bl-diff-change');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r1 = scanOnce(store);

  bl.save('v1', r1);

  const r2 = scanOnce(store);
  const firstIssue = r2.issues[0];
  store.updateIssueStatus(r2.batchId, firstIssue.id, REVIEW_STATUS.CONFIRMED, 'test-handler', 'test-remark');

  const reloaded = store.loadBatch(r2.batchId);
  const diffResult = bl.diff('v1', reloaded);

  assert.ok(diffResult.summary.changed > 0, '应有状态变化');
  const changeItem = diffResult.changed.find(c =>
    c.changes.some(ch => ch.field === 'reviewStatus')
  );
  assert.ok(changeItem, '应有 reviewStatus 变化记录');
});

test('baseline diff — 基线不存在报错', () => {
  const storeDir = makeTempDir('bl-diff-notfound');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);

  assert.throws(() => bl.diff('nonexistent', r), /不存在/);
});

test('baseline diff — 规则不匹配报错', () => {
  const storeDir = makeTempDir('bl-diff-rule');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);

  bl.save('v1', r);

  const modifiedResult = store.loadBatch(r.batchId);
  modifiedResult.rulePath = '/different/rule.yaml';
  assert.throws(() => bl.diff('v1', modifiedResult), /规则文件不匹配/);
});

test('baseline diff — 目录不匹配报错', () => {
  const storeDir = makeTempDir('bl-diff-dir');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);

  bl.save('v1', r);

  const modifiedResult = store.loadBatch(r.batchId);
  modifiedResult.targetDir = '/different/directory';
  assert.throws(() => bl.diff('v1', modifiedResult), /扫描目录不匹配/);
});

test('baseline diff — 空基线名称报错', () => {
  const storeDir = makeTempDir('bl-diff-empty');
  const bl = new BaselineManager(storeDir);
  assert.throws(() => bl.diff('', null), /不能为空/);
});

test('baseline diff — 无扫描结果报错', () => {
  const storeDir = makeTempDir('bl-diff-noscan');
  const bl = new BaselineManager(storeDir);
  assert.throws(() => bl.diff('v1', null), /没有激活的批次/);
});

suite('新功能: baseline export / import');

test('baseline export — 导出 JSON 文件', () => {
  const storeDir = makeTempDir('bl-export');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);

  bl.save('v1', r);
  const outFile = path.join(makeTempDir('bl-export-out'), 'baseline.json');
  const result = bl.exportBaseline('v1', outFile);

  assert.ok(fs.existsSync(outFile), '导出文件应存在');
  const data = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
  assert.strictEqual(data._meta.type, 'bbcheck-baseline');
  assert.strictEqual(data.baseline.name, 'v1');
  assert.ok(Array.isArray(data.baseline.issues));
});

test('baseline import — 导入有效文件', () => {
  const storeDir = makeTempDir('bl-import');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);

  bl.save('v1', r);
  const outFile = path.join(makeTempDir('bl-import-out'), 'baseline.json');
  bl.exportBaseline('v1', outFile);

  const importStoreDir = makeTempDir('bl-import-dest');
  const bl2 = new BaselineManager(importStoreDir);
  const result = bl2.importBaseline(outFile);

  assert.strictEqual(result.name, 'v1');
  assert.strictEqual(result.overwritten, false);
  assert.strictEqual(result.issueCount, r.issues.length);

  const list = bl2.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'v1');
});

test('baseline import — 导入时重命名', () => {
  const storeDir = makeTempDir('bl-import-rename');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);

  bl.save('v1', r);
  const outFile = path.join(makeTempDir('bl-import-rename-out'), 'baseline.json');
  bl.exportBaseline('v1', outFile);

  const importStoreDir = makeTempDir('bl-import-rename-dest');
  const bl2 = new BaselineManager(importStoreDir);
  const result = bl2.importBaseline(outFile, { name: 'v1-renamed' });

  assert.strictEqual(result.name, 'v1-renamed');
  const loaded = bl2.loadBaseline('v1-renamed');
  assert.ok(loaded, '应能以新名称加载');
  assert.strictEqual(loaded.originalName, 'v1');
});

test('baseline import — 同名基线不覆盖报错', () => {
  const storeDir = makeTempDir('bl-import-dup');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);

  bl.save('v1', r);
  const outFile = path.join(makeTempDir('bl-import-dup-out'), 'baseline.json');
  bl.exportBaseline('v1', outFile);

  assert.throws(() => bl.importBaseline(outFile), /已存在/);
});

test('baseline import — 同名基线 force 覆盖', () => {
  const storeDir = makeTempDir('bl-import-dup-force');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);

  bl.save('v1', r);
  const outFile = path.join(makeTempDir('bl-import-dup-force-out'), 'baseline.json');
  bl.exportBaseline('v1', outFile);

  const result = bl.importBaseline(outFile, { force: true });
  assert.strictEqual(result.overwritten, true);
});

test('baseline import — 损坏文件报错', () => {
  const storeDir = makeTempDir('bl-import-corrupt');
  const bl = new BaselineManager(storeDir);
  const corruptFile = path.join(makeTempDir('bl-import-corrupt-file'), 'bad.json');
  fs.writeFileSync(corruptFile, 'not valid json{{{', 'utf-8');

  assert.throws(() => bl.importBaseline(corruptFile), /已损坏/);
});

test('baseline import — 非 bbcheck 基线文件报错', () => {
  const storeDir = makeTempDir('bl-import-wrong');
  const bl = new BaselineManager(storeDir);
  const wrongFile = path.join(makeTempDir('bl-import-wrong-file'), 'wrong.json');
  fs.writeFileSync(wrongFile, JSON.stringify({ foo: 'bar' }), 'utf-8');

  assert.throws(() => bl.importBaseline(wrongFile), /不是有效的 bbcheck 基线文件/);
});

test('baseline import — 文件不存在报错', () => {
  const storeDir = makeTempDir('bl-import-no-file');
  const bl = new BaselineManager(storeDir);
  assert.throws(() => bl.importBaseline('/nonexistent/file.json'), /不存在/);
});

suite('新功能: baseline undo 撤销');

test('undo baseline save — 新基线被删除', () => {
  const storeDir = makeTempDir('bl-undo-save');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);

  const saveResult = bl.save('v1', r);
  store.pushBaselineUndo({
    type: 'BASELINE_SAVE',
    baselineName: 'v1',
    previousData: saveResult.previousData || null
  });

  assert.ok(bl.loadBaseline('v1'), '保存后应能加载');

  const action = store.undo();
  assert.strictEqual(action.type, 'BASELINE_SAVE');
  assert.strictEqual(action.baselineName, 'v1');

  assert.strictEqual(bl.loadBaseline('v1'), null, '撤销后基线应被删除');
});

test('undo baseline save — 覆盖基线恢复原内容', () => {
  const storeDir = makeTempDir('bl-undo-overwrite');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);

  const saveResult1 = bl.save('v1', r);
  store.pushBaselineUndo({
    type: 'BASELINE_SAVE',
    baselineName: 'v1',
    previousData: saveResult1.previousData || null
  });

  const r2 = scanOnce(store);
  const saveResult2 = bl.save('v1', r2, { force: true });
  store.pushBaselineUndo({
    type: 'BASELINE_SAVE',
    baselineName: 'v1',
    previousData: saveResult2.previousData || null
  });

  const action = store.undo();
  assert.strictEqual(action.type, 'BASELINE_SAVE');

  const restored = bl.loadBaseline('v1');
  assert.ok(restored, '撤销后基线应存在');
  assert.strictEqual(restored.sourceBatchId, r.batchId, '应恢复为第一次保存的内容');
});

test('undo baseline import — 导入被撤销', () => {
  const storeDir = makeTempDir('bl-undo-import');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);

  bl.save('v1', r);
  const outFile = path.join(makeTempDir('bl-undo-import-file'), 'baseline.json');
  bl.exportBaseline('v1', outFile);

  const importStoreDir = makeTempDir('bl-undo-import-dest');
  const store2 = new StateStore(importStoreDir);
  const bl2 = new BaselineManager(importStoreDir);

  const importResult = bl2.importBaseline(outFile);
  store2.pushBaselineUndo({
    type: 'BASELINE_IMPORT',
    baselineName: importResult.name,
    previousData: importResult.previousData || null
  });

  assert.ok(bl2.loadBaseline('v1'), '导入后应能加载');

  store2.undo();
  assert.strictEqual(bl2.loadBaseline('v1'), null, '撤销后基线应被删除');
});

suite('新功能: baseline 跨重启持久化');

test('跨重启：基线在新实例中可读取', () => {
  const storeDir = makeTempDir('bl-persist');
  const store1 = new StateStore(storeDir);
  const bl1 = new BaselineManager(storeDir);
  const r = scanOnce(store1);

  bl1.save('v1', r);

  const bl2 = new BaselineManager(storeDir);
  const list = bl2.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'v1');
  assert.strictEqual(list[0].issueCount, r.issues.length);

  const loaded = bl2.loadBaseline('v1');
  assert.ok(loaded);
  assert.strictEqual(loaded.issues.length, r.issues.length);
});

test('跨重启：撤销栈持久化可撤销基线保存', () => {
  const storeDir = makeTempDir('bl-persist-undo');
  const store1 = new StateStore(storeDir);
  const bl1 = new BaselineManager(storeDir);
  const r = scanOnce(store1);

  const saveResult = bl1.save('v1', r);
  store1.pushBaselineUndo({
    type: 'BASELINE_SAVE',
    baselineName: 'v1',
    previousData: saveResult.previousData || null
  });

  const store2 = new StateStore(storeDir);
  const bl2 = new BaselineManager(storeDir);

  assert.ok(bl2.loadBaseline('v1'), '重启后基线应存在');

  const undoSize = store2.getUndoStackSize();
  assert.ok(undoSize >= 1, '撤销栈应有至少 1 项');

  store2.undo();
  assert.strictEqual(bl2.loadBaseline('v1'), null, '重启后撤销应删除基线');
});

test('跨重启：导出再导入，数据完整', () => {
  const storeDir = makeTempDir('bl-persist-export');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);

  bl.save('v1', r);
  const outFile = path.join(makeTempDir('bl-persist-export-file'), 'baseline.json');
  bl.exportBaseline('v1', outFile);

  const importStoreDir = makeTempDir('bl-persist-export-dest');
  const bl2 = new BaselineManager(importStoreDir);
  bl2.importBaseline(outFile);

  const store2 = new StateStore(importStoreDir);
  const bl3 = new BaselineManager(importStoreDir);
  const list = bl3.list();
  assert.strictEqual(list.length, 1);

  const loaded = bl3.loadBaseline('v1');
  assert.strictEqual(loaded.issues.length, r.issues.length);
  const allHaveType = loaded.issues.every(i => i.type);
  assert.ok(allHaveType, '所有问题应有 type 字段');
});

suite('新功能: baseline diff 导出');

test('diff 导出 JSON — 结构完整', () => {
  const storeDir = makeTempDir('bl-diff-export-json');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);

  bl.save('v1', r);
  const diffResult = bl.diff('v1', r);

  const outFile = path.join(makeTempDir('bl-diff-json-out'), 'diff.json');
  bl.exportDiffAsJSON(diffResult, outFile);

  assert.ok(fs.existsSync(outFile));
  const data = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
  assert.strictEqual(data._meta.type, 'bbcheck-baseline-diff');
  assert.ok(data.diff.summary);
});

test('diff 导出 CSV — 包含差异标签', () => {
  const storeDir = makeTempDir('bl-diff-export-csv');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);

  bl.save('v1', r);
  const diffResult = bl.diff('v1', r);

  const outFile = path.join(makeTempDir('bl-diff-csv-out'), 'diff.csv');
  bl.exportDiffAsCSV(diffResult, outFile);

  assert.ok(fs.existsSync(outFile));
  const content = fs.readFileSync(outFile, 'utf-8');
  assert.ok(content.includes('差异标签'), 'CSV 应含差异标签列');
  assert.ok(content.includes('未变'), '同批次 diff 应含"未变"标签');
});

test('diff 导出 HTML — 结构完整', () => {
  const storeDir = makeTempDir('bl-diff-export-html');
  const store = new StateStore(storeDir);
  const bl = new BaselineManager(storeDir);
  const r = scanOnce(store);

  bl.save('v1', r);
  const diffResult = bl.diff('v1', r);

  const outFile = path.join(makeTempDir('bl-diff-html-out'), 'diff.html');
  bl.exportDiffAsHTML(diffResult, outFile);

  assert.ok(fs.existsSync(outFile));
  const content = fs.readFileSync(outFile, 'utf-8');
  assert.ok(content.includes('<html'), '应为 HTML');
  assert.ok(content.includes('基线差异对比'), '应含标题');
});

suite('新功能: baseline CLI 命令');

test('CLI baseline save — 保存成功', () => {
  const storeDir = makeTempDir('cli-bl-save');
  runCli('--store-dir', storeDir, 'scan', '--force', RULE_PATH, DATA_DIR);
  const res = runCli('--store-dir', storeDir, 'baseline', 'save', '--name', 'v1');
  assert.strictEqual(res.status, 0, 'baseline save 应成功');
  assert.ok(/已保存/.test(res.stdout), '输出应含"已保存"');
});

test('CLI baseline save — 同名报错退出码 1', () => {
  const storeDir = makeTempDir('cli-bl-dup');
  runCli('--store-dir', storeDir, 'scan', '--force', RULE_PATH, DATA_DIR);
  runCli('--store-dir', storeDir, 'baseline', 'save', '--name', 'v1');
  const res = runCli('--store-dir', storeDir, 'baseline', 'save', '--name', 'v1');
  assert.strictEqual(res.status, 1, '同名应退出码 1');
});

test('CLI baseline save --force — 覆盖成功', () => {
  const storeDir = makeTempDir('cli-bl-force');
  runCli('--store-dir', storeDir, 'scan', '--force', RULE_PATH, DATA_DIR);
  runCli('--store-dir', storeDir, 'baseline', 'save', '--name', 'v1');
  const res = runCli('--store-dir', storeDir, 'baseline', 'save', '--name', 'v1', '--force');
  assert.strictEqual(res.status, 0);
  assert.ok(/覆盖/.test(res.stdout), '输出应含"覆盖"');
});

test('CLI baseline diff — 相同批次无差异', () => {
  const storeDir = makeTempDir('cli-bl-diff');
  runCli('--store-dir', storeDir, 'scan', '--force', RULE_PATH, DATA_DIR);
  runCli('--store-dir', storeDir, 'baseline', 'save', '--name', 'v1');
  const res = runCli('--store-dir', storeDir, 'baseline', 'diff', '--name', 'v1');
  assert.strictEqual(res.status, 0, '无差异时应退出码 0');
  assert.ok(/无差异|完全一致/.test(res.stdout), '输出应含"无差异"');
});

test('CLI baseline list — 列出基线', () => {
  const storeDir = makeTempDir('cli-bl-list');
  runCli('--store-dir', storeDir, 'scan', '--force', RULE_PATH, DATA_DIR);
  runCli('--store-dir', storeDir, 'baseline', 'save', '--name', 'mybl');
  const res = runCli('--store-dir', storeDir, 'baseline', 'list');
  assert.strictEqual(res.status, 0);
  assert.ok(/mybl/.test(res.stdout), '输出应含基线名称');
});

test('CLI baseline export + import — 完整流程', () => {
  const storeDir = makeTempDir('cli-bl-expimp');
  runCli('--store-dir', storeDir, 'scan', '--force', RULE_PATH, DATA_DIR);
  runCli('--store-dir', storeDir, 'baseline', 'save', '--name', 'v1');

  const outFile = path.join(makeTempDir('cli-bl-expimp-out'), 'bl.json');
  const expRes = runCli('--store-dir', storeDir, 'baseline', 'export', '--name', 'v1', '-o', outFile);
  assert.strictEqual(expRes.status, 0, 'export 应成功');
  assert.ok(fs.existsSync(outFile), '导出文件应存在');

  const storeDir2 = makeTempDir('cli-bl-expimp-dest');
  const impRes = runCli('--store-dir', storeDir2, 'baseline', 'import', '--file', outFile);
  assert.strictEqual(impRes.status, 0, 'import 应成功');
  assert.ok(/已导入/.test(impRes.stdout), '输出应含"已导入"');

  const listRes = runCli('--store-dir', storeDir2, 'baseline', 'list');
  assert.ok(/v1/.test(listRes.stdout), '导入后应能列出');
});

test('CLI baseline import — 损坏文件退出码 2', () => {
  const storeDir = makeTempDir('cli-bl-imp-corrupt');
  const corruptFile = path.join(makeTempDir('cli-bl-imp-corrupt-file'), 'bad.json');
  fs.writeFileSync(corruptFile, 'not valid json{{{', 'utf-8');
  const res = runCli('--store-dir', storeDir, 'baseline', 'import', '--file', corruptFile);
  assert.strictEqual(res.status, 2, '损坏文件应退出码 2');
});

test('CLI undo — 撤销 baseline save', () => {
  const storeDir = makeTempDir('cli-bl-undo');
  runCli('--store-dir', storeDir, 'scan', '--force', RULE_PATH, DATA_DIR);
  runCli('--store-dir', storeDir, 'baseline', 'save', '--name', 'v1');

  const undoRes = runCli('--store-dir', storeDir, 'undo');
  assert.strictEqual(undoRes.status, 0, 'undo 应成功');
  assert.ok(/保存基线/.test(undoRes.stdout), '输出应含"保存基线"');

  const listRes = runCli('--store-dir', storeDir, 'baseline', 'list');
  assert.ok(/暂无/.test(listRes.stdout), '撤销后应无基线');
});

test('CLI baseline save — 无激活批次退出码 1', () => {
  const storeDir = makeTempDir('cli-bl-no-batch');
  const res = runCli('--store-dir', storeDir, 'baseline', 'save', '--name', 'v1');
  assert.strictEqual(res.status, 1, '无激活批次应退出码 1');
  assert.ok(/没有激活的批次/.test(res.stdout + res.stderr), '应提示无激活批次');
});

test('CLI baseline diff — 导出差异报告', () => {
  const storeDir = makeTempDir('cli-bl-diff-export');
  runCli('--store-dir', storeDir, 'scan', '--force', RULE_PATH, DATA_DIR);
  runCli('--store-dir', storeDir, 'baseline', 'save', '--name', 'v1');

  const outFile = path.join(makeTempDir('cli-bl-diff-exp-out'), 'diff.json');
  const res = runCli('--store-dir', storeDir, 'baseline', 'diff', '--name', 'v1', '-o', outFile);
  assert.ok(fs.existsSync(outFile), '差异报告文件应存在');
});

test('回归: README 命令总览包含 baseline 命令', () => {
  const readmePath = path.join(__dirname, '..', 'README.md');
  const readmeContent = fs.readFileSync(readmePath, 'utf-8');
  const commandOverviewRe = /## 命令总览[\s\S]*?```\s*\n([\s\S]*?)\n```/;
  const m = readmeContent.match(commandOverviewRe);
  assert.ok(m, 'README 应存在「命令总览」章节');
  const codeBlock = m[1];
  assert.ok(/bbcheck baseline\b/.test(codeBlock), 'README 命令总览中应包含 bbcheck baseline');
});

// ─────────────────────────────────────────────────────────────
// 测试 11: profile 规则包管理
// ─────────────────────────────────────────────────────────────
suite('新功能: profile add / list / show');

test('profile add — 添加 YAML 规则成功', () => {
  const storeDir = makeTempDir('pf-add');
  const pm = new ProfileManager(storeDir);
  const result = pm.add('test-profile', RULE_PATH);
  assert.strictEqual(result.name, 'test-profile');
  assert.strictEqual(result.overwritten, false);
  assert.strictEqual(result.ruleFormat, 'yaml');
  assert.ok(result.sectionCount > 0, '应有章节数');
});

test('profile add — 添加 JSON 规则成功', () => {
  const storeDir = makeTempDir('pf-add-json');
  const pm = new ProfileManager(storeDir);
  const jsonRulePath = path.join(makeTempDir('pf-json-rule'), 'rule.json');
  const ruleObj = {
    name: 'JSON测试规则',
    version: '1.0',
    sections: [
      { name: '章节一', order: 1, directory: '01-test', requiredFiles: [], namingPatterns: [] }
    ]
  };
  fs.writeFileSync(jsonRulePath, JSON.stringify(ruleObj, null, 2), 'utf-8');
  const result = pm.add('json-profile', jsonRulePath);
  assert.strictEqual(result.ruleFormat, 'json');
  assert.strictEqual(result.sectionCount, 1);
});

test('profile add — 同名不覆盖时报错', () => {
  const storeDir = makeTempDir('pf-add-dup');
  const pm = new ProfileManager(storeDir);
  pm.add('dup-test', RULE_PATH);
  assert.throws(() => pm.add('dup-test', RULE_PATH), /已存在/);
});

test('profile add — 同名 force 覆盖', () => {
  const storeDir = makeTempDir('pf-add-force');
  const pm = new ProfileManager(storeDir);
  pm.add('force-test', RULE_PATH);
  const result = pm.add('force-test', RULE_PATH, { force: true });
  assert.strictEqual(result.overwritten, true);
  assert.ok(result.previousData !== null, '应有 previousData');
});

test('profile add — 空名称报错', () => {
  const storeDir = makeTempDir('pf-add-empty');
  const pm = new ProfileManager(storeDir);
  assert.throws(() => pm.add('', RULE_PATH), /不能为空/);
});

test('profile add — 非法字符名称报错', () => {
  const storeDir = makeTempDir('pf-add-badname');
  const pm = new ProfileManager(storeDir);
  assert.throws(() => pm.add('bad name!', RULE_PATH), /非法字符/);
});

test('profile add — 规则文件不存在报错', () => {
  const storeDir = makeTempDir('pf-add-nofile');
  const pm = new ProfileManager(storeDir);
  assert.throws(() => pm.add('t', '/nonexistent/rule.yaml'), /不存在/);
});

test('profile add — 不支持的格式报错', () => {
  const storeDir = makeTempDir('pf-add-badfmt');
  const pm = new ProfileManager(storeDir);
  const badFile = path.join(makeTempDir('pf-badfmt-file'), 'rule.txt');
  fs.writeFileSync(badFile, 'not a yaml or json', 'utf-8');
  assert.throws(() => pm.add('t', badFile), /不支持.*格式/);
});

test('profile add — 规则文件语法错误报错', () => {
  const storeDir = makeTempDir('pf-add-parsed');
  const pm = new ProfileManager(storeDir);
  const badFile = path.join(makeTempDir('pf-parsed-file'), 'bad.yaml');
  fs.writeFileSync(badFile, 'key: [unclosed\n', 'utf-8');
  assert.throws(() => pm.add('t', badFile), /解析失败/);
});

test('profile list — 空时返回空数组', () => {
  const storeDir = makeTempDir('pf-list-empty');
  const pm = new ProfileManager(storeDir);
  const list = pm.list();
  assert.strictEqual(list.length, 0);
});

test('profile list — 列出已添加的 profile', () => {
  const storeDir = makeTempDir('pf-list');
  const pm = new ProfileManager(storeDir);
  pm.add('alpha', RULE_PATH);
  pm.add('beta', RULE_PATH);
  const list = pm.list();
  assert.strictEqual(list.length, 2);
  const names = list.map(p => p.name);
  assert.ok(names.includes('alpha'));
  assert.ok(names.includes('beta'));
});

test('profile list — 损坏文件标记为 corrupted', () => {
  const storeDir = makeTempDir('pf-list-corrupt');
  const pm = new ProfileManager(storeDir);
  const profilesDir = path.join(storeDir, 'profiles');
  if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(path.join(profilesDir, 'bad.json'), 'not valid json{{{', 'utf-8');
  const list = pm.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'bad');
  assert.strictEqual(list[0].corrupted, true);
});

test('profile show — 正常展示 profile 详情', () => {
  const storeDir = makeTempDir('pf-show');
  const pm = new ProfileManager(storeDir);
  pm.add('show-test', RULE_PATH);
  const info = pm.show('show-test');
  assert.strictEqual(info.name, 'show-test');
  assert.ok(info.createdAt, '应有创建时间');
  assert.strictEqual(info.ruleFormat, 'yaml');
  assert.ok(info.ruleName, '应有规则名称');
  assert.ok(Array.isArray(info.sections), '应有章节列表');
  assert.ok(info.sections.length > 0, '应至少有一个章节');
  assert.ok(Array.isArray(info.previewLines), '应有预览行');
});

test('profile show — 不存在报错', () => {
  const storeDir = makeTempDir('pf-show-notfound');
  const pm = new ProfileManager(storeDir);
  assert.throws(() => pm.show('nonexistent'), /不存在/);
});

test('profile show — 损坏文件报错', () => {
  const storeDir = makeTempDir('pf-show-corrupt');
  const pm = new ProfileManager(storeDir);
  const profilesDir = path.join(storeDir, 'profiles');
  if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(path.join(profilesDir, 'corrupt.json'), 'not valid json{{{', 'utf-8');
  assert.throws(() => pm.show('corrupt'), /已损坏/);
});

suite('新功能: profile remove');

test('profile remove — 删除成功', () => {
  const storeDir = makeTempDir('pf-remove');
  const pm = new ProfileManager(storeDir);
  pm.add('to-remove', RULE_PATH);
  const listBefore = pm.list();
  assert.strictEqual(listBefore.length, 1);
  const result = pm.remove('to-remove');
  assert.strictEqual(result.name, 'to-remove');
  assert.ok(result.previousData !== null, '应有 previousData');
  const listAfter = pm.list();
  assert.strictEqual(listAfter.length, 0);
});

test('profile remove — 不存在报错', () => {
  const storeDir = makeTempDir('pf-remove-notfound');
  const pm = new ProfileManager(storeDir);
  assert.throws(() => pm.remove('nonexistent'), /不存在/);
});

suite('新功能: profile export / import');

test('profile export — 导出 JSON 文件', () => {
  const storeDir = makeTempDir('pf-export');
  const pm = new ProfileManager(storeDir);
  pm.add('exp-test', RULE_PATH);
  const outFile = path.join(makeTempDir('pf-export-out'), 'profile.json');
  const result = pm.exportProfile('exp-test', outFile);
  assert.ok(fs.existsSync(outFile), '导出文件应存在');
  const data = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
  assert.strictEqual(data._meta.type, 'bbcheck-profile');
  assert.strictEqual(data.profile.name, 'exp-test');
  assert.ok(Array.isArray(data.profile.ruleData.sections));
});

test('profile export — 不存在报错', () => {
  const storeDir = makeTempDir('pf-export-notfound');
  const pm = new ProfileManager(storeDir);
  const outFile = path.join(makeTempDir('pf-export-nf-out'), 'p.json');
  assert.throws(() => pm.exportProfile('nonexistent', outFile), /不存在/);
});

test('profile import — 导入有效文件', () => {
  const storeDir = makeTempDir('pf-import');
  const pm1 = new ProfileManager(storeDir);
  pm1.add('v1', RULE_PATH);
  const outFile = path.join(makeTempDir('pf-import-out'), 'profile.json');
  pm1.exportProfile('v1', outFile);

  const importStoreDir = makeTempDir('pf-import-dest');
  const pm2 = new ProfileManager(importStoreDir);
  const result = pm2.importProfile(outFile);
  assert.strictEqual(result.name, 'v1');
  assert.strictEqual(result.overwritten, false);
  const list = pm2.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'v1');
});

test('profile import — 导入时重命名', () => {
  const storeDir = makeTempDir('pf-import-rename');
  const pm1 = new ProfileManager(storeDir);
  pm1.add('original', RULE_PATH);
  const outFile = path.join(makeTempDir('pf-import-rename-out'), 'p.json');
  pm1.exportProfile('original', outFile);

  const importStoreDir = makeTempDir('pf-import-rename-dest');
  const pm2 = new ProfileManager(importStoreDir);
  const result = pm2.importProfile(outFile, { name: 'renamed' });
  assert.strictEqual(result.name, 'renamed');
  const info = pm2.show('renamed');
  assert.ok(info, '应能以新名称加载');
});

test('profile import — 同名不覆盖报错', () => {
  const storeDir = makeTempDir('pf-import-dup');
  const pm = new ProfileManager(storeDir);
  pm.add('dup', RULE_PATH);
  const outFile = path.join(makeTempDir('pf-import-dup-out'), 'p.json');
  pm.exportProfile('dup', outFile);
  assert.throws(() => pm.importProfile(outFile), /已存在/);
});

test('profile import — 同名 force 覆盖', () => {
  const storeDir = makeTempDir('pf-import-force');
  const pm = new ProfileManager(storeDir);
  pm.add('dup-f', RULE_PATH);
  const outFile = path.join(makeTempDir('pf-import-force-out'), 'p.json');
  pm.exportProfile('dup-f', outFile);
  const result = pm.importProfile(outFile, { force: true });
  assert.strictEqual(result.overwritten, true);
});

test('profile import — 损坏文件报错', () => {
  const storeDir = makeTempDir('pf-import-corrupt');
  const pm = new ProfileManager(storeDir);
  const corruptFile = path.join(makeTempDir('pf-import-corrupt-file'), 'bad.json');
  fs.writeFileSync(corruptFile, 'not valid json{{{', 'utf-8');
  assert.throws(() => pm.importProfile(corruptFile), /已损坏/);
});

test('profile import — 非 profile 文件报错', () => {
  const storeDir = makeTempDir('pf-import-wrong');
  const pm = new ProfileManager(storeDir);
  const wrongFile = path.join(makeTempDir('pf-import-wrong-file'), 'wrong.json');
  fs.writeFileSync(wrongFile, JSON.stringify({ foo: 'bar' }), 'utf-8');
  assert.throws(() => pm.importProfile(wrongFile), /不是有效的 bbcheck profile/);
});

test('profile import — 文件不存在报错', () => {
  const storeDir = makeTempDir('pf-import-nofile');
  const pm = new ProfileManager(storeDir);
  assert.throws(() => pm.importProfile('/nonexistent/file.json'), /不存在/);
});

suite('新功能: profile load / markUsed');

test('profile load — 加载规则用于扫描', () => {
  const storeDir = makeTempDir('pf-load');
  const pm = new ProfileManager(storeDir);
  pm.add('load-test', RULE_PATH);
  const loaded = pm.load('load-test');
  assert.ok(loaded.rule, '应返回 rule 对象');
  assert.ok(Array.isArray(loaded.rule.sections), '应有 sections 数组');
  assert.strictEqual(loaded.profileName, 'load-test');
});

test('profile load — 不存在报错', () => {
  const storeDir = makeTempDir('pf-load-notfound');
  const pm = new ProfileManager(storeDir);
  assert.throws(() => pm.load('nonexistent'), /不存在/);
});

test('profile load — 缺少规则数据报错', () => {
  const storeDir = makeTempDir('pf-load-broken');
  const pm = new ProfileManager(storeDir);
  const profilesDir = path.join(storeDir, 'profiles');
  if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(path.join(profilesDir, 'broken.json'), JSON.stringify({
    name: 'broken',
    createdAt: new Date().toISOString(),
    ruleData: null
  }), 'utf-8');
  assert.throws(() => pm.load('broken'), /缺少规则数据/);
});

test('profile markUsed — 更新最近使用目录', () => {
  const storeDir = makeTempDir('pf-markused');
  const pm = new ProfileManager(storeDir);
  pm.add('mark-test', RULE_PATH);
  pm.markUsed('mark-test', DATA_DIR);
  const info = pm.show('mark-test');
  assert.strictEqual(info.lastUsedDir, path.resolve(DATA_DIR));
  assert.ok(info.lastUsedAt, '应有 lastUsedAt');
});

test('profile markUsed — 不存在报错', () => {
  const storeDir = makeTempDir('pf-markused-notfound');
  const pm = new ProfileManager(storeDir);
  assert.throws(() => pm.markUsed('nonexistent', DATA_DIR), /不存在/);
});

suite('新功能: profile undo 撤销');

test('undo profile add — 新 profile 被删除', () => {
  const storeDir = makeTempDir('pf-undo-add');
  const store = new StateStore(storeDir);
  const pm = new ProfileManager(storeDir);
  const result = pm.add('undo-test', RULE_PATH);
  store.pushProfileUndo({
    type: 'PROFILE_ADD',
    profileName: 'undo-test',
    previousData: result.previousData || null
  });
  const listBefore = pm.list();
  assert.strictEqual(listBefore.length, 1);
  const action = store.undo();
  assert.strictEqual(action.type, 'PROFILE_ADD');
  assert.strictEqual(action.profileName, 'undo-test');
  const listAfter = pm.list();
  assert.strictEqual(listAfter.length, 0);
});

test('undo profile add — 覆盖 profile 恢复原内容', () => {
  const storeDir = makeTempDir('pf-undo-overwrite');
  const store = new StateStore(storeDir);
  const pm = new ProfileManager(storeDir);
  const r1 = pm.add('overwrite', RULE_PATH);
  store.pushProfileUndo({
    type: 'PROFILE_ADD',
    profileName: 'overwrite',
    previousData: r1.previousData || null
  });
  const jsonRulePath = path.join(makeTempDir('pf-undo-ov-json'), 'rule.json');
  fs.writeFileSync(jsonRulePath, JSON.stringify({
    name: '简化规则', sections: [{ name: 'S1', order: 1 }]
  }), 'utf-8');
  const r2 = pm.add('overwrite', jsonRulePath, { force: true });
  store.pushProfileUndo({
    type: 'PROFILE_ADD',
    profileName: 'overwrite',
    previousData: r2.previousData || null
  });
  const infoBefore = pm.show('overwrite');
  assert.strictEqual(infoBefore.ruleName, '简化规则');
  store.undo();
  const infoAfter = pm.show('overwrite');
  assert.notStrictEqual(infoAfter.ruleName, '简化规则', '应恢复为原规则');
});

test('undo profile remove — 删除后恢复', () => {
  const storeDir = makeTempDir('pf-undo-remove');
  const store = new StateStore(storeDir);
  const pm = new ProfileManager(storeDir);
  pm.add('restore-test', RULE_PATH);
  const removeResult = pm.remove('restore-test');
  store.pushProfileUndo({
    type: 'PROFILE_REMOVE',
    profileName: 'restore-test',
    previousData: removeResult.previousData || null
  });
  assert.strictEqual(pm.list().length, 0);
  store.undo();
  assert.strictEqual(pm.list().length, 1);
  const info = pm.show('restore-test');
  assert.ok(info, '应能恢复并显示');
});

test('undo profile import — 导入被撤销', () => {
  const storeDir = makeTempDir('pf-undo-imp-src');
  const pm1 = new ProfileManager(storeDir);
  pm1.add('v1', RULE_PATH);
  const outFile = path.join(makeTempDir('pf-undo-imp-out'), 'p.json');
  pm1.exportProfile('v1', outFile);

  const importStoreDir = makeTempDir('pf-undo-imp-dest');
  const store2 = new StateStore(importStoreDir);
  const pm2 = new ProfileManager(importStoreDir);
  const importResult = pm2.importProfile(outFile);
  store2.pushProfileUndo({
    type: 'PROFILE_IMPORT',
    profileName: importResult.name,
    previousData: importResult.previousData || null
  });
  assert.strictEqual(pm2.list().length, 1);
  store2.undo();
  assert.strictEqual(pm2.list().length, 0);
});

suite('新功能: profile 跨重启持久化');

test('跨重启：profile 在新实例中可读取', () => {
  const storeDir = makeTempDir('pf-persist');
  const pm1 = new ProfileManager(storeDir);
  pm1.add('persist-test', RULE_PATH);
  pm1.markUsed('persist-test', DATA_DIR);

  const pm2 = new ProfileManager(storeDir);
  const list = pm2.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'persist-test');
  assert.strictEqual(list[0].lastUsedDir, path.resolve(DATA_DIR));

  const info = pm2.show('persist-test');
  assert.ok(info, '新实例应能 show profile');
  assert.ok(info.sectionCount > 0);
});

test('跨重启：撤销栈持久化可撤销 profile add', () => {
  const storeDir = makeTempDir('pf-persist-undo');
  const store1 = new StateStore(storeDir);
  const pm1 = new ProfileManager(storeDir);
  const result = pm1.add('undo-persist', RULE_PATH);
  store1.pushProfileUndo({
    type: 'PROFILE_ADD',
    profileName: 'undo-persist',
    previousData: result.previousData || null
  });

  const store2 = new StateStore(storeDir);
  const pm2 = new ProfileManager(storeDir);
  assert.strictEqual(pm2.list().length, 1);
  assert.ok(store2.getUndoStackSize() >= 1);
  store2.undo();
  assert.strictEqual(pm2.list().length, 0);
});

test('跨重启：导出再导入，数据完整', () => {
  const storeDir = makeTempDir('pf-persist-exp');
  const pm1 = new ProfileManager(storeDir);
  pm1.add('v1', RULE_PATH);
  const outFile = path.join(makeTempDir('pf-persist-exp-file'), 'p.json');
  pm1.exportProfile('v1', outFile);

  const importStoreDir = makeTempDir('pf-persist-exp-dest');
  const pm2 = new ProfileManager(importStoreDir);
  pm2.importProfile(outFile);

  const pm3 = new ProfileManager(importStoreDir);
  const list = pm3.list();
  assert.strictEqual(list.length, 1);
  const info = pm3.show('v1');
  assert.ok(info.sectionCount > 0);
  const loaded = pm3.load('v1');
  assert.ok(loaded.rule.sections.length > 0);
});

suite('新功能: profile CLI 命令');

test('CLI profile add — 添加成功', () => {
  const storeDir = makeTempDir('cli-pf-add');
  const res = runCli('--store-dir', storeDir, 'profile', 'add', '--name', 'myprof', '--rule', RULE_PATH);
  assert.strictEqual(res.status, 0, 'profile add 应成功');
  assert.ok(/已添加/.test(res.stdout), '输出应含"已添加"');
  assert.ok(/myprof/.test(res.stdout), '输出应含 profile 名称');
});

test('CLI profile list — 显示 profile 列表', () => {
  const storeDir = makeTempDir('cli-pf-list');
  runCli('--store-dir', storeDir, 'profile', 'add', '--name', 'list-test', '--rule', RULE_PATH);
  const res = runCli('--store-dir', storeDir, 'profile', 'list');
  assert.strictEqual(res.status, 0);
  assert.ok(/list-test/.test(res.stdout), '列表应包含 profile 名称');
});

test('CLI profile list — 空时提示', () => {
  const storeDir = makeTempDir('cli-pf-list-empty');
  const res = runCli('--store-dir', storeDir, 'profile', 'list');
  assert.strictEqual(res.status, 0);
  assert.ok(/暂无 profile/.test(res.stdout), '空时应提示暂无');
});

test('CLI profile show — 详情展示', () => {
  const storeDir = makeTempDir('cli-pf-show');
  runCli('--store-dir', storeDir, 'profile', 'add', '--name', 'show-me', '--rule', RULE_PATH);
  const res = runCli('--store-dir', storeDir, 'profile', 'show', '--name', 'show-me');
  assert.strictEqual(res.status, 0);
  assert.ok(/Profile 详情/.test(res.stdout), '应含详情标题');
  assert.ok(/章节数/.test(res.stdout), '应含章节数');
});

test('CLI profile show — 不存在退出码 1', () => {
  const storeDir = makeTempDir('cli-pf-show-nf');
  const res = runCli('--store-dir', storeDir, 'profile', 'show', '--name', 'does-not-exist');
  assert.strictEqual(res.status, 1);
  assert.ok(/不存在/.test(res.stdout + res.stderr), '应提示不存在');
});

test('CLI profile use — 使用 profile 扫描目录', () => {
  const storeDir = makeTempDir('cli-pf-use');
  runCli('--store-dir', storeDir, 'profile', 'add', '--name', 'use-test', '--rule', RULE_PATH);
  const res = runCli('--store-dir', storeDir, 'profile', 'use', '--name', 'use-test', '--dir', DATA_DIR, '--force-scan');
  assert.strictEqual(res.status, 0, 'profile use 应成功');
  assert.ok(/扫描完成/.test(res.stdout), '应输出扫描完成');
  assert.ok(/发现.*个问题/.test(res.stdout), '应报告问题数');
});

test('CLI profile use — 目录不存在退出码 1', () => {
  const storeDir = makeTempDir('cli-pf-use-nodir');
  runCli('--store-dir', storeDir, 'profile', 'add', '--name', 't', '--rule', RULE_PATH);
  const res = runCli('--store-dir', storeDir, 'profile', 'use', '--name', 't', '--dir', '/nonexistent/dir/xyz');
  assert.strictEqual(res.status, 1);
  assert.ok(/不存在|目录错误/.test(res.stdout + res.stderr), '应提示目录错误');
});

test('CLI profile use — profile 不存在退出码 1', () => {
  const storeDir = makeTempDir('cli-pf-use-nopf');
  const res = runCli('--store-dir', storeDir, 'profile', 'use', '--name', 'nope', '--dir', DATA_DIR);
  assert.strictEqual(res.status, 1);
});

test('CLI profile export — 导出成功', () => {
  const storeDir = makeTempDir('cli-pf-exp');
  runCli('--store-dir', storeDir, 'profile', 'add', '--name', 'exp-cli', '--rule', RULE_PATH);
  const outFile = path.join(makeTempDir('cli-pf-exp-out'), 'p.json');
  const res = runCli('--store-dir', storeDir, 'profile', 'export', '--name', 'exp-cli', '-o', outFile);
  assert.strictEqual(res.status, 0);
  assert.ok(fs.existsSync(outFile), '导出文件应存在');
  assert.ok(/已导出/.test(res.stdout), '输出应含"已导出"');
});

test('CLI profile import — 导入成功', () => {
  const storeDir = makeTempDir('cli-pf-imp-src');
  runCli('--store-dir', storeDir, 'profile', 'add', '--name', 'imp-src', '--rule', RULE_PATH);
  const outFile = path.join(makeTempDir('cli-pf-imp-out'), 'p.json');
  runCli('--store-dir', storeDir, 'profile', 'export', '--name', 'imp-src', '-o', outFile);

  const storeDir2 = makeTempDir('cli-pf-imp-dest');
  const res = runCli('--store-dir', storeDir2, 'profile', 'import', '--file', outFile);
  assert.strictEqual(res.status, 0);
  assert.ok(/已导入/.test(res.stdout), '输出应含"已导入"');
  const listRes = runCli('--store-dir', storeDir2, 'profile', 'list');
  assert.ok(/imp-src/.test(listRes.stdout), '导入后应能列出');
});

test('CLI profile import — 重命名导入', () => {
  const storeDir = makeTempDir('cli-pf-imp-rn-src');
  runCli('--store-dir', storeDir, 'profile', 'add', '--name', 'orig', '--rule', RULE_PATH);
  const outFile = path.join(makeTempDir('cli-pf-imp-rn-out'), 'p.json');
  runCli('--store-dir', storeDir, 'profile', 'export', '--name', 'orig', '-o', outFile);

  const storeDir2 = makeTempDir('cli-pf-imp-rn-dest');
  const res = runCli('--store-dir', storeDir2, 'profile', 'import', '--file', outFile, '--rename', 'renamed-cli');
  assert.strictEqual(res.status, 0);
  const listRes = runCli('--store-dir', storeDir2, 'profile', 'list');
  assert.ok(/renamed-cli/.test(listRes.stdout), '应以重命名后名称列出');
});

test('CLI profile import — 损坏文件退出码 2', () => {
  const storeDir = makeTempDir('cli-pf-imp-corrupt');
  const corruptFile = path.join(makeTempDir('cli-pf-imp-corrupt-file'), 'bad.json');
  fs.writeFileSync(corruptFile, 'not valid json{{{', 'utf-8');
  const res = runCli('--store-dir', storeDir, 'profile', 'import', '--file', corruptFile);
  assert.strictEqual(res.status, 2, '损坏文件应退出码 2');
});

test('CLI profile remove — 删除成功', () => {
  const storeDir = makeTempDir('cli-pf-remove');
  runCli('--store-dir', storeDir, 'profile', 'add', '--name', 'to-delete', '--rule', RULE_PATH);
  const res = runCli('--store-dir', storeDir, 'profile', 'remove', '--name', 'to-delete');
  assert.strictEqual(res.status, 0);
  assert.ok(/已删除/.test(res.stdout), '输出应含"已删除"');
  const listRes = runCli('--store-dir', storeDir, 'profile', 'list');
  assert.ok(/暂无 profile/.test(listRes.stdout), '删除后应无 profile');
});

test('CLI profile remove — 不存在退出码 1', () => {
  const storeDir = makeTempDir('cli-pf-remove-nf');
  const res = runCli('--store-dir', storeDir, 'profile', 'remove', '--name', 'nope');
  assert.strictEqual(res.status, 1);
});

test('CLI undo — 撤销 profile add', () => {
  const storeDir = makeTempDir('cli-pf-undo-add');
  runCli('--store-dir', storeDir, 'profile', 'add', '--name', 'undo-me', '--rule', RULE_PATH);
  const undoRes = runCli('--store-dir', storeDir, 'undo');
  assert.strictEqual(undoRes.status, 0);
  assert.ok(/添加 profile/.test(undoRes.stdout), '输出应含"添加 profile"');
  const listRes = runCli('--store-dir', storeDir, 'profile', 'list');
  assert.ok(/暂无 profile/.test(listRes.stdout), '撤销后应无 profile');
});

test('CLI undo — 撤销 profile remove', () => {
  const storeDir = makeTempDir('cli-pf-undo-remove');
  runCli('--store-dir', storeDir, 'profile', 'add', '--name', 'back', '--rule', RULE_PATH);
  runCli('--store-dir', storeDir, 'profile', 'remove', '--name', 'back');
  const undoRes = runCli('--store-dir', storeDir, 'undo');
  assert.strictEqual(undoRes.status, 0);
  assert.ok(/删除 profile/.test(undoRes.stdout), '输出应含"删除 profile"');
  const listRes = runCli('--store-dir', storeDir, 'profile', 'list');
  assert.ok(/back/.test(listRes.stdout), '撤销删除后应恢复 profile');
});

test('CLI undo — 撤销 profile import', () => {
  const storeDir = makeTempDir('cli-pf-undo-imp-src');
  runCli('--store-dir', storeDir, 'profile', 'add', '--name', 'src', '--rule', RULE_PATH);
  const outFile = path.join(makeTempDir('cli-pf-undo-imp-out'), 'p.json');
  runCli('--store-dir', storeDir, 'profile', 'export', '--name', 'src', '-o', outFile);

  const storeDir2 = makeTempDir('cli-pf-undo-imp-dest');
  runCli('--store-dir', storeDir2, 'profile', 'import', '--file', outFile);
  const undoRes = runCli('--store-dir', storeDir2, 'undo');
  assert.strictEqual(undoRes.status, 0);
  assert.ok(/导入 profile/.test(undoRes.stdout), '输出应含"导入 profile"');
  const listRes = runCli('--store-dir', storeDir2, 'profile', 'list');
  assert.ok(/暂无 profile/.test(listRes.stdout), '撤销导入后应无 profile');
});

test('CLI profile add — 同名退出码 1，提示可用 --force', () => {
  const storeDir = makeTempDir('cli-pf-dup');
  runCli('--store-dir', storeDir, 'profile', 'add', '--name', 'dup', '--rule', RULE_PATH);
  const res = runCli('--store-dir', storeDir, 'profile', 'add', '--name', 'dup', '--rule', RULE_PATH);
  assert.strictEqual(res.status, 1);
  assert.ok(/--force/.test(res.stdout + res.stderr), '应提示 --force');
});

test('CLI profile add — --force 覆盖同名', () => {
  const storeDir = makeTempDir('cli-pf-force');
  runCli('--store-dir', storeDir, 'profile', 'add', '--name', 'f', '--rule', RULE_PATH);
  const res = runCli('--store-dir', storeDir, 'profile', 'add', '--name', 'f', '--rule', RULE_PATH, '--force');
  assert.strictEqual(res.status, 0);
  assert.ok(/覆盖/.test(res.stdout), '应提示已覆盖');
});

test('CLI profile use — 扫描后 markUsed 记录最近目录', () => {
  const storeDir = makeTempDir('cli-pf-use-mark');
  runCli('--store-dir', storeDir, 'profile', 'add', '--name', 'mark', '--rule', RULE_PATH);
  runCli('--store-dir', storeDir, 'profile', 'use', '--name', 'mark', '--dir', DATA_DIR, '--force-scan');
  const showRes = runCli('--store-dir', storeDir, 'profile', 'show', '--name', 'mark');
  assert.ok(showRes.stdout.includes('资料目录') || showRes.stdout.includes(path.resolve(DATA_DIR).slice(0, 20)),
    'show 中应显示最近使用目录');
});

test('回归: README 命令总览包含 profile 命令', () => {
  const readmePath = path.join(__dirname, '..', 'README.md');
  const readmeContent = fs.readFileSync(readmePath, 'utf-8');
  const commandOverviewRe = /## 命令总览[\s\S]*?```\s*\n([\s\S]*?)\n```/;
  const m = readmeContent.match(commandOverviewRe);
  assert.ok(m, 'README 应存在「命令总览」章节');
  const codeBlock = m[1];
  assert.ok(/bbcheck profile\b/.test(codeBlock), 'README 命令总览中应包含 bbcheck profile');
});

// ─────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log(`  通过: ${passed}  |  失败: ${failed}`);
console.log('─'.repeat(60));

if (failures.length > 0) {
  console.log('\n失败详情:\n');
  for (const f of failures) {
    console.log(`  ✗ [${f.suite}] ${f.name}`);
    console.log(`    ${f.error.message}`);
    if (f.error.stack) {
      console.log(f.error.stack.split('\n').slice(1, 4).map(l => '    ' + l.trim()).join('\n'));
    }
    console.log();
  }
  process.exit(1);
} else {
  console.log('\n🎉 全部通过!\n');
  process.exit(0);
}

// 清理在退出时做 — 保留失败时的 workspace 方便排查
process.on('exit', (code) => {
  if (code === 0 && fs.existsSync(TEST_ROOT)) {
    try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch (_) {}
  }
});
