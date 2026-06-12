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
