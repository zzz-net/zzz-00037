const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { RuleParser } = require('../src/rule-parser');
const { Scanner } = require('../src/scanner');
const { StateStore } = require('../src/state-store');
const { Exporter } = require('../src/exporter');
const { REVIEW_STATUS } = require('../src/models');

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
      // 只接受已知命令模式：validate, scan, resume, review, status, undo, export, list, history, init-samples
      if (/^(validate|scan|resume|review|status|undo|export|list|history|init-samples)$/.test(name)) {
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
