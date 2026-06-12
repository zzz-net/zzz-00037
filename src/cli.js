#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const yargs = require('yargs');
const chalk = require('chalk');
const Table = require('cli-table3');

const { RuleParser, RuleValidationError } = require('./rule-parser');
const { Scanner, DirectoryNotFoundError } = require('./scanner');
const { StateStore, EmptyUndoStackError } = require('./state-store');
const { Exporter, ExportError } = require('./exporter');
const {
  ISSUE_TYPES, ISSUE_TYPE_LABELS,
  REVIEW_STATUS, REVIEW_STATUS_LABELS,
  ScanResult
} = require('./models');

const store = new StateStore();
const parser = new RuleParser();
const scanner = new Scanner();
const exporter = new Exporter();

function printIssueTable(issues, opts = {}) {
  const table = new Table({
    head: [
      chalk.cyan('#'),
      chalk.cyan('ID'),
      chalk.cyan('类型'),
      chalk.cyan('严重'),
      chalk.cyan('状态'),
      chalk.cyan('处理人'),
      chalk.cyan('章节'),
      chalk.cyan('描述')
    ],
    colWidths: [5, 20, 12, 8, 10, 10, 12, 50],
    wordWrap: true
  });

  issues.forEach((issue, i) => {
    const sevColor = { error: 'red', warn: 'yellow', info: 'blue' }[issue.severity] || 'white';
    const stColor = {
      [REVIEW_STATUS.PENDING]: 'yellow',
      [REVIEW_STATUS.CONFIRMED]: 'green',
      [REVIEW_STATUS.IGNORED]: 'gray'
    }[issue.reviewStatus] || 'white';

    const section = (issue.details && issue.details.section) || '-';
    table.push([
      (opts.startIndex || 0) + i + 1,
      issue.id.slice(0, 16) + '…',
      chalk.white(ISSUE_TYPE_LABELS[issue.type] || issue.type),
      chalk[sevColor]({ error: '错误', warn: '警告', info: '提示' }[issue.severity] || issue.severity),
      chalk[stColor](REVIEW_STATUS_LABELS[issue.reviewStatus] || issue.reviewStatus),
      issue.handler || '-',
      section,
      issue.message
    ]);
  });

  console.log(table.toString());
}

function printSummary(summary) {
  console.log(chalk.bold('\n📊 扫描汇总:'));
  const total = summary.total;
  const pending = summary.byStatus.pending || 0;
  const confirmed = summary.byStatus.confirmed || 0;
  const ignored = summary.byStatus.ignored || 0;

  console.log(
    `  总数: ${chalk.bold.white(total)}  |  ` +
    `${chalk.yellow('待补: ' + pending)}  |  ` +
    `${chalk.green('已确认: ' + confirmed)}  |  ` +
    `${chalk.gray('忽略: ' + ignored)}`
  );

  console.log(chalk.bold('\n📂 按类型统计:'));
  for (const [type, count] of Object.entries(summary.byType)) {
    console.log(`  - ${ISSUE_TYPE_LABELS[type] || type}: ${chalk.bold(count)}`);
  }
  console.log();
}

yargs
  .scriptName('bbcheck')
  .usage('$0 <command> [options]')
  .option('store-dir', {
    describe: '状态存储目录',
    type: 'string',
    default: path.join(process.cwd(), '.bbcheck')
  })
  .middleware((argv) => {
    if (argv.storeDir) {
      const newStore = new StateStore(argv.storeDir);
      Object.assign(store, newStore);
    }
  });

yargs
  .command('scan <rule> <dir>', '扫描资料目录', (y) => {
    y
      .positional('rule', { describe: '规则文件路径 (YAML/JSON)', type: 'string' })
      .positional('dir', { describe: '资料目录路径', type: 'string' })
      .option('force', { alias: 'f', describe: '强制重新扫描（即使目录已扫描）', type: 'boolean', default: false })
      .option('output', { alias: 'o', describe: '直接导出结果到指定文件', type: 'string' });
  }, async (argv) => {
    try {
      console.log(chalk.blue('📖 加载规则文件...'));
      const rule = parser.load(argv.rule);
      console.log(chalk.green(`  ✓ 规则: ${rule.name} (章节: ${rule.sections.length})`));

      const absDir = path.resolve(argv.dir);
      if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
        throw new DirectoryNotFoundError(absDir);
      }

      const preScanCheck = store.hasBatchForDirectory(absDir);
      if (preScanCheck.exists && !argv.force) {
        console.log(chalk.yellow('⚠ 该目录已有扫描记录:'));
        console.log(`  最近扫描时间: ${preScanCheck.lastScanTime}`);
        console.log(`  关联批次: ${preScanCheck.batches.slice(-3).join(', ')}`);
        console.log(chalk.gray('  使用 --force 强制重新扫描\n'));
        const batchId = preScanCheck.batches[preScanCheck.batches.length - 1];
        store.setActiveBatch(batchId);
        const existing = store.loadBatch(batchId);
        if (existing) {
          console.log(chalk.cyan(`📋 批次 ${batchId} 的扫描结果:\n`));
          printIssueTable(existing.issues);
          printSummary(existing.summary);
        }
        process.exit(0);
        return;
      }

      console.log(chalk.blue('🔍 开始扫描目录...'));
      const result = scanner.scan(absDir, rule);
      console.log(chalk.green(`  ✓ 扫描完成: 发现 ${result.issues.length} 个问题`));
      console.log(chalk.gray(`  ✓ 批次ID: ${result.batchId}`));
      console.log(chalk.gray(`  ✓ 扫描文件数: ${result.scannedFiles.length}`));

      store.saveBatch(result);
      console.log(chalk.green('  ✓ 状态已保存\n'));

      printIssueTable(result.issues);
      printSummary(result.summary);

      if (argv.output) {
        const outPath = path.resolve(argv.output);
        const exp = exporter.exportAuto(result, outPath);
        console.log(chalk.green(`📤 已导出到: ${outPath}`));
      }

      console.log(chalk.cyan('💡 下一步:'));
      console.log(`  ${chalk.gray('$')} bbcheck review       # 交互式复核问题`);
      console.log(`  ${chalk.gray('$')} bbcheck status       # 查看当前批次状态`);
      console.log(`  ${chalk.gray('$')} bbcheck export <out> # 导出报告\n`);

    } catch (e) {
      if (e instanceof RuleValidationError) {
        console.error(chalk.red('❌ 规则文件错误:'));
        console.error(chalk.red(e.message));
      } else if (e instanceof DirectoryNotFoundError) {
        console.error(chalk.red('❌ 目录错误:'));
        console.error(chalk.red(e.message));
      } else {
        console.error(chalk.red('❌ 扫描失败:' + (e.stack || e.message)));
      }
      process.exit(1);
    }
  });

yargs
  .command('resume [batchId]', '恢复处理（继续上次未完成的批次）', (y) => {
    y.positional('batchId', { describe: '批次ID (不填则使用最近一次激活的批次)', type: 'string' });
  }, async (argv) => {
    let batchId = argv.batchId;
    if (!batchId) {
      batchId = store.getActiveBatchId();
      if (!batchId) {
        console.error(chalk.red('❌ 没有激活的批次，请先运行 scan 或指定 batchId'));
        const batches = store.listBatches(10);
        if (batches.length > 0) {
          console.log(chalk.yellow('\n可用批次:'));
          for (const b of batches) {
            console.log(`  ${b.batchId}  ${b.targetDir}  (${b.lastScanTime})`);
          }
        }
        process.exit(1);
        return;
      }
    }

    const result = store.loadBatch(batchId);
    if (!result) {
      console.error(chalk.red(`❌ 批次不存在: ${batchId}`));
      process.exit(1);
      return;
    }

    store.setActiveBatch(batchId);
    console.log(chalk.green(`✨ 已恢复批次 ${batchId}\n`));
    console.log(chalk.cyan(`  规则: ${result.rulePath}`));
    console.log(chalk.cyan(`  目录: ${result.targetDir}`));
    console.log(chalk.cyan(`  扫描时间: ${result.scanTime}\n`));

    printIssueTable(result.issues);
    printSummary(result.summary);

    console.log(chalk.cyan('💡 下一步:'));
    console.log(`  ${chalk.gray('$')} bbcheck review       # 交互式复核问题`);
    console.log(`  ${chalk.gray('$')} bbcheck undo         # 撤销上一步操作\n`);
  });

yargs
  .command('review', '交互式复核问题', (y) => {
    y
      .option('batch', { alias: 'b', describe: '批次ID (默认激活批次)', type: 'string' })
      .option('handler', { alias: 'H', describe: '处理人', type: 'string', default: process.env.USER || process.env.USERNAME || 'unknown' })
      .option('status', { alias: 's', describe: '批量设置所有问题的状态 (pending/confirmed/ignored)', type: 'string' })
      .option('ids', { describe: '批量处理指定ID (逗号分隔)', type: 'string' })
      .option('remark', { alias: 'r', describe: '备注', type: 'string', default: '' })
      .option('type', { alias: 't', describe: '按问题类型批量过滤 (如 MISSING_FILE / 缺失文件)', type: 'string' })
      .option('filter', { alias: 'f', describe: '按当前状态批量过滤 (pending/confirmed/ignored)', type: 'string' });
  }, async (argv) => {
    try {
      let batchId = argv.batch || store.getActiveBatchId();
      if (!batchId) {
        console.error(chalk.red('❌ 没有激活的批次，请先运行 scan 或 resume'));
        process.exit(1);
        return;
      }

      const result = store.loadBatch(batchId);
      if (!result) {
        console.error(chalk.red(`❌ 批次不存在: ${batchId}`));
        process.exit(1);
        return;
      }

      if (argv.status) {
        const targetStatus = argv.status.toLowerCase();
        if (!Object.values(REVIEW_STATUS).includes(targetStatus)) {
          console.error(chalk.red(`❌ 无效状态: ${argv.status}，可选: ${Object.values(REVIEW_STATUS).join('/')}`));
          process.exit(1);
          return;
        }

        let targetIssues = result.issues;
        if (argv.type) {
          const typeKey = Object.keys(ISSUE_TYPE_LABELS).find(
            k => k === argv.type ||
              ISSUE_TYPE_LABELS[k] === argv.type ||
              k.toLowerCase() === argv.type.toLowerCase()
          );
          if (typeKey) {
            targetIssues = targetIssues.filter(i => i.type === typeKey);
          } else {
            console.log(chalk.yellow(`⚠ 未识别的类型: ${argv.type}，已忽略该条件`));
          }
        }
        if (argv.filter) {
          targetIssues = targetIssues.filter(i => i.reviewStatus === argv.filter.toLowerCase());
        }
        if (argv.ids) {
          const idList = argv.ids.split(',').map(s => s.trim());
          targetIssues = targetIssues.filter(i =>
            idList.includes(i.id) || idList.some(id => i.id.startsWith(id))
          );
        }

        if (targetIssues.length === 0) {
          console.log(chalk.yellow('⚠ 没有匹配的问题'));
          return;
        }

        const updates = targetIssues.map(i => ({
          issueId: i.id,
          status: targetStatus,
          remark: argv.remark
        }));

        const changes = store.batchUpdateIssues(batchId, updates, argv.handler);
        console.log(chalk.green(`✓ 已批量更新 ${changes.length} 个问题为"${REVIEW_STATUS_LABELS[targetStatus]}"`));
        const updated = store.loadBatch(batchId);
        printSummary(updated.summary);
        return;
      }

      const inquirer = require('inquirer');
      console.log(chalk.blue(`📝 交互式复核 (批次: ${batchId}, 处理人: ${argv.handler})\n`));

      const pendingIssues = result.issues.filter(i => i.reviewStatus === REVIEW_STATUS.PENDING);
      if (pendingIssues.length === 0) {
        console.log(chalk.green('🎉 没有待复核的问题！'));
        printSummary(result.summary);
        return;
      }

      console.log(chalk.yellow(`待复核 ${pendingIssues.length} / ${result.issues.length} 个问题\n`));

      let cursor = 0;
      while (cursor < pendingIssues.length) {
        const issue = pendingIssues[cursor];
        console.log(chalk.cyan(`\n━━━ 问题 ${cursor + 1}/${pendingIssues.length} ━━━`));
        console.log(`  ID: ${issue.id}`);
        console.log(`  类型: ${ISSUE_TYPE_LABELS[issue.type] || issue.type}  |  严重: ${issue.severity}`);
        console.log(`  章节: ${(issue.details && issue.details.section) || '-'}`);
        console.log(`  路径: ${issue.targetPath || '-'}`);
        console.log(`  描述: ${chalk.bold(issue.message)}`);
        if (issue.expected) console.log(`  期望: ${issue.expected}`);
        if (issue.actual) console.log(`  实际: ${issue.actual}`);

        const answers = await inquirer.prompt([
          {
            type: 'list',
            name: 'status',
            message: '选择处理方式:',
            choices: [
              { name: '待补 (稍后处理)', value: REVIEW_STATUS.PENDING },
              { name: '已确认 (确认问题存在)', value: REVIEW_STATUS.CONFIRMED },
              { name: '忽略 (非关键问题)', value: REVIEW_STATUS.IGNORED },
              { name: '跳过这个问题', value: 'SKIP' },
              { name: '停止复核', value: 'QUIT' }
            ],
            default: REVIEW_STATUS.PENDING
          },
          {
            type: 'input',
            name: 'remark',
            message: '备注 (可选):',
            default: issue.remark || '',
            when: (a) => a.status !== 'SKIP' && a.status !== 'QUIT'
          }
        ]);

        if (answers.status === 'QUIT') {
          console.log(chalk.yellow('\n🛑 已停止复核'));
          break;
        }
        if (answers.status === 'SKIP') {
          cursor++;
          continue;
        }

        store.updateIssueStatus(batchId, issue.id, answers.status, argv.handler, answers.remark || '');
        console.log(chalk.green(`  ✓ 已标记为"${REVIEW_STATUS_LABELS[answers.status]}"`));
        cursor++;
      }

      const finalResult = store.loadBatch(batchId);
      console.log(chalk.green('\n━━━ 复核完成 ━━━'));
      printSummary(finalResult.summary);

    } catch (e) {
      if (e.message && e.message.includes('User force closed')) {
        console.log(chalk.yellow('\n🛑 已取消'));
        return;
      }
      console.error(chalk.red('❌ 复核失败: ' + (e.message || e)));
      process.exit(1);
    }
  });

yargs
  .command('status', '查看当前批次状态', (y) => {
    y.option('batch', { alias: 'b', describe: '批次ID (默认激活批次)', type: 'string' });
    y.option('filter', { alias: 'f', describe: '按状态过滤 (pending/confirmed/ignored)', type: 'string' });
    y.option('type', { alias: 't', describe: '按问题类型过滤', type: 'string' });
  }, async (argv) => {
    let batchId = argv.batch || store.getActiveBatchId();
    if (!batchId) {
      console.error(chalk.red('❌ 没有激活的批次'));
      const batches = store.listBatches(5);
      if (batches.length > 0) {
        console.log(chalk.yellow('\n可用批次:'));
        for (const b of batches) {
          console.log(`  ${b.batchId}  ${b.targetDir}  (${b.lastScanTime})`);
        }
      }
      process.exit(1);
      return;
    }

    const result = store.loadBatch(batchId);
    if (!result) {
      console.error(chalk.red(`❌ 批次不存在: ${batchId}`));
      process.exit(1);
      return;
    }

    console.log(chalk.cyan('📋 批次信息:'));
    console.log(`  ID: ${result.batchId}`);
    console.log(`  规则: ${result.rulePath}`);
    console.log(`  目录: ${result.targetDir}`);
    console.log(`  扫描时间: ${result.scanTime}\n`);

    let issues = result.issues;
    if (argv.filter) {
      issues = issues.filter(i => i.reviewStatus === argv.filter.toLowerCase());
    }
    if (argv.type) {
      const typeKey = Object.keys(ISSUE_TYPE_LABELS).find(
        k => ISSUE_TYPE_LABELS[k] === argv.type || k.toLowerCase() === argv.type.toLowerCase()
      );
      if (typeKey) issues = issues.filter(i => i.type === typeKey);
    }

    printIssueTable(issues);
    printSummary(result.summary);
  });

yargs
  .command('undo', '撤销上一步操作', (y) => {
    y.option('dry-run', { describe: '只查看要撤销的操作，不实际执行', type: 'boolean', default: false });
  }, async (argv) => {
    const stackSize = store.getUndoStackSize();
    if (stackSize === 0) {
      console.log(chalk.yellow('⚠ 撤销栈为空，没有可撤销的操作'));
      process.exit(0);
      return;
    }

    console.log(chalk.blue(`🔙 可撤销操作数: ${stackSize}`));

    if (argv.dryRun) {
      console.log(chalk.gray('  --dry-run 模式，不执行实际撤销'));
      return;
    }

    try {
      const action = store.undo();
      const typeLabels = {
        NEW_BATCH: '创建新批次',
        UPDATE_BATCH: '更新批次',
        ISSUE_CHANGE: '问题状态变更',
        BATCH_ISSUE_CHANGE: `批量问题变更 (${action.count || 0}个)`
      };
      console.log(chalk.green(`✓ 已撤销: ${typeLabels[action.type] || action.type}`));
      console.log(chalk.gray(`  批次ID: ${action.batchId}`));
      if (action.issueId) {
        console.log(chalk.gray(`  问题ID: ${action.issueId}`));
      }

      const stackSizeNow = store.getUndoStackSize();
      if (stackSizeNow > 0) {
        console.log(chalk.yellow(`  剩余可撤销: ${stackSizeNow} 步`));
      } else {
        console.log(chalk.gray('  撤销栈已清空'));
      }
    } catch (e) {
      if (e instanceof EmptyUndoStackError) {
        console.log(chalk.yellow('⚠ 撤销栈为空'));
      } else {
        console.error(chalk.red('❌ 撤销失败: ' + e.message));
        process.exit(1);
      }
    }
  });

yargs
  .command('export <output>', '导出复核报告', (y) => {
    y
      .positional('output', { describe: '输出文件路径 (.csv / .html / .json)', type: 'string' })
      .option('batch', { alias: 'b', describe: '批次ID (默认激活批次)', type: 'string' })
      .option('format', { alias: 'f', describe: '强制指定格式 (csv/html/json)', type: 'string' });
  }, async (argv) => {
    try {
      let batchId = argv.batch || store.getActiveBatchId();
      if (!batchId) {
        console.error(chalk.red('❌ 没有激活的批次，请先运行 scan 或 resume'));
        process.exit(1);
        return;
      }

      const result = store.loadBatch(batchId);
      if (!result) {
        console.error(chalk.red(`❌ 批次不存在: ${batchId}`));
        process.exit(1);
        return;
      }

      let outPath = path.resolve(argv.output);
      let expResult;

      if (argv.format) {
        const fmt = argv.format.toLowerCase();
        if (fmt === 'csv') {
          if (!outPath.toLowerCase().endsWith('.csv')) outPath += '.csv';
          expResult = exporter.exportCSV(result, outPath);
        } else if (fmt === 'html') {
          if (!outPath.toLowerCase().endsWith('.html') && !outPath.toLowerCase().endsWith('.htm')) outPath += '.html';
          expResult = exporter.exportHTML(result, outPath);
        } else if (fmt === 'json') {
          if (!outPath.toLowerCase().endsWith('.json')) outPath += '.json';
          expResult = exporter.exportJSON(result, outPath);
        } else {
          throw new ExportError(`不支持的格式: ${fmt}`);
        }
      } else {
        expResult = exporter.exportAuto(result, outPath);
      }

      console.log(chalk.green(`📤 导出成功!`));
      console.log(`  格式: ${expResult.type.toUpperCase()}`);
      console.log(`  路径: ${outPath}`);
      console.log(`  问题数: ${expResult.issues}`);
      if (expResult.rows) console.log(`  行数: ${expResult.rows}`);

      console.log(chalk.cyan('\n📊 报告数据快照:'));
      printSummary(result.summary);

    } catch (e) {
      if (e instanceof ExportError) {
        console.error(chalk.red('❌ 导出错误: ' + e.message));
      } else {
        console.error(chalk.red('❌ 导出失败: ' + (e.message || e)));
      }
      process.exit(1);
    }
  });

yargs
  .command('list', '列出所有扫描批次', (y) => {
    y.option('limit', { alias: 'n', describe: '显示数量', type: 'number', default: 20 });
  }, async (argv) => {
    const batches = store.listBatches(argv.limit);
    if (batches.length === 0) {
      console.log(chalk.yellow('⚠ 暂无扫描批次'));
      return;
    }

    const table = new Table({
      head: [
        chalk.cyan('批次ID'),
        chalk.cyan('规则'),
        chalk.cyan('扫描目录'),
        chalk.cyan('扫描时间'),
        chalk.cyan('问题总数'),
        chalk.cyan('待补')
      ],
      colWidths: [28, 30, 40, 22, 10, 8],
      wordWrap: true
    });

    const activeId = store.getActiveBatchId();
    for (const b of batches) {
      const mark = b.batchId === activeId ? '⭐ ' : '  ';
      table.push([
        mark + b.batchId,
        b.rulePath ? path.basename(b.rulePath) : '-',
        b.targetDir || '-',
        b.lastModified || b.scanTime || '-',
        b.totalIssues,
        b.pendingIssues
      ]);
    }

    console.log(table.toString());
    console.log(chalk.gray(`\n共 ${batches.length} 个批次 (⭐ 为当前激活批次)`));
  });

yargs
  .command('history <issueId>', '查看单个问题的复核历史', (y) => {
    y
      .positional('issueId', { describe: '问题ID (可输入前缀)', type: 'string' })
      .option('batch', { alias: 'b', describe: '批次ID (默认激活批次)', type: 'string' });
  }, async (argv) => {
    let batchId = argv.batch || store.getActiveBatchId();
    if (!batchId) {
      console.error(chalk.red('❌ 没有激活的批次'));
      process.exit(1);
      return;
    }

    const result = store.loadBatch(batchId);
    if (!result) {
      console.error(chalk.red(`❌ 批次不存在: ${batchId}`));
      process.exit(1);
      return;
    }

    const issue = result.issues.find(i =>
      i.id === argv.issueId || i.id.startsWith(argv.issueId)
    );
    if (!issue) {
      console.error(chalk.red(`❌ 问题不存在: ${argv.issueId}`));
      process.exit(1);
      return;
    }

    console.log(chalk.cyan('📋 问题详情:'));
    console.log(`  ID: ${issue.id}`);
    console.log(`  类型: ${ISSUE_TYPE_LABELS[issue.type] || issue.type}`);
    console.log(`  严重: ${issue.severity}`);
    console.log(`  当前状态: ${REVIEW_STATUS_LABELS[issue.reviewStatus]}`);
    console.log(`  处理人: ${issue.handler || '-'}`);
    console.log(`  备注: ${issue.remark || '-'}`);
    console.log(`  描述: ${issue.message}\n`);

    if (issue.reviewHistory && issue.reviewHistory.length > 0) {
      console.log(chalk.bold('📜 复核历史:'));
      for (let i = issue.reviewHistory.length - 1; i >= 0; i--) {
        const h = issue.reviewHistory[i];
        const idx = issue.reviewHistory.length - i;
        console.log(`  ${idx}. [${h.timestamp}]`);
        console.log(`     ${REVIEW_STATUS_LABELS[h.from]} → ${REVIEW_STATUS_LABELS[h.to]}`);
        console.log(`     处理人: ${h.handler || '-'}`);
        if (h.remark) console.log(`     备注: ${h.remark}`);
      }
    } else {
      console.log(chalk.gray('  暂无复核历史'));
    }
  });

yargs
  .command('init-samples', '生成样例规则和资料目录', (y) => {
    y.option('out-dir', { alias: 'o', describe: '输出目录', type: 'string', default: './bid-samples' });
  }, async (argv) => {
    const outDir = path.resolve(argv.outDir);
    const rulePath = path.join(outDir, 'rule.yaml');
    const samplesDir = path.join(outDir, '资料目录');

    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    if (!fs.existsSync(samplesDir)) fs.mkdirSync(samplesDir, { recursive: true });

    const ruleYaml = `# 投标文件装订检查规则样例
name: "XX项目投标文件装订规则"
description: "用于XX项目投标文件完整性和装订顺序检查"
version: "1.0"
globalSignatureRequired: false
globalPageRange: null
globalExpiryField: null

sections:
  - name: "商务部分"
    order: 1
    directory: "01-商务部分"
    description: "包含投标函、资质文件等商务材料"
    signatureRequired: true
    requiredFiles:
      - path: "投标函.pdf"
        description: "正式投标函文件"
      - path: "法定代表人身份证明_签章.pdf"
        description: "法定代表人身份证明"
      - path: "授权委托书_签章.pdf"
        optional: true
        description: "如为委托代理人则必需"
    namingPatterns:
      - pattern: "^\\d{2}-[\\u4e00-\\u9fa5A-Za-z0-9_]+\\.(pdf|doc|docx)$"
        label: "编号-名称.扩展名"
      - pattern: "^[\\u4e00-\\u9fa5]{2,}_v(\\d+)(?:\\.\\d+)*\\.pdf$"
        label: "名称_v版本号.pdf"
        extractVersion: true
        versionGroup: 1
    pageRange: "1-30"
    expiryField:
      fieldName: "cert_expiry"
      dateFormat: "YYYY-MM-DD"

  - name: "技术部分"
    order: 2
    directory: "02-技术部分"
    description: "技术方案、实施方案等"
    allowUntracked: false
    requiredFiles:
      - path: "技术方案.pdf"
      - path: "项目实施计划.pdf"
    namingPatterns:
      - pattern: "^[\\u4e00-\\u9fa5A-Za-z0-9_]+\\.pdf$"
        label: "中文名.pdf"
    pageRange: "31-80"

  - name: "报价部分"
    order: 3
    directory: "03-报价部分"
    description: "报价单、价格明细等"
    signatureRequired: true
    requiredFiles:
      - path: "报价一览表_签章.pdf"
        signatureRequired: true
      - path: "分项报价表_签章.pdf"
        signatureRequired: true
    namingPatterns:
      - pattern: "^[\\u4e00-\\u9fa5]+_签章\\.pdf$"
        label: "名称_签章.pdf"
    pageRange: "81-100"
`;

    fs.writeFileSync(rulePath, ruleYaml, 'utf-8');
    console.log(chalk.green(`✓ 已生成规则: ${rulePath}`));

    const dirs = [
      path.join(samplesDir, '01-商务部分'),
      path.join(samplesDir, '02-技术部分'),
      path.join(samplesDir, '03-报价部分'),
      path.join(samplesDir, '04-其他资料')
    ];
    for (const d of dirs) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }

    const files = [
      ['01-商务部分', '投标函.pdf', '%PDF-1.4 模拟投标函内容 页码范围1-5'],
      ['01-商务部分', '法定代表人身份证明_签章.pdf', '%PDF-1.4 法人证明 已签章'],
      ['01-商务部分', '资质证书_20200101.pdf', '%PDF-1.4 已过期资质证书模拟'],
      ['01-商务部分', '资质证书_v2.pdf', '%PDF-1.4 重复版本'],
      ['01-商务部分', '资质证书_v3.pdf', '%PDF-1.4 重复版本 v3'],
      ['02-技术部分', '技术方案.pdf', '%PDF-1.4 技术方案内容'],
      ['02-技术部分', '错误命名_xxx.txt', '无效格式'],
      ['02-技术部分', 'random_unplanned_file.pdf', '%PDF-1.4 未在规则中'],
      ['03-报价部分', '报价一览表.pdf', '%PDF-1.4 缺少签章标记'],
      ['04-其他资料', '补充说明.pdf', '%PDF-1.4 未在规则目录中']
    ];
    for (const [subdir, filename, content] of files) {
      const fp = path.join(samplesDir, subdir, filename);
      fs.writeFileSync(fp, content, 'utf-8');
    }
    console.log(chalk.green(`✓ 已生成样例目录: ${samplesDir}`));

    console.log(chalk.cyan('\n✨ 样例已创建完成！接下来可以运行:'));
    console.log(`  ${chalk.gray('$')} npm install                           # 安装依赖`);
    console.log(`  ${chalk.gray('$')} node src/cli.js scan ${JSON.stringify(rulePath)} ${JSON.stringify(samplesDir)}  # 扫描`);
    console.log(`  ${chalk.gray('$')} node src/cli.js review --handler 张三   # 复核`);
    console.log(`  ${chalk.gray('$')} node src/cli.js undo                    # 撤销`);
    console.log(`  ${chalk.gray('$')} node src/cli.js export report.html      # 导出HTML报告\n`);
  });

yargs
  .strict()
  .demandCommand(1, chalk.red('❌ 请指定命令，使用 --help 查看帮助'))
  .help('help')
  .alias('h', 'help')
  .version()
  .alias('v', 'version')
  .epilogue(chalk.gray('bid-binder-checker v1.0.0 - 本地投标文件装订检查工具'))
  .parse();
