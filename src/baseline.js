const fs = require('fs');
const path = require('path');
const { ISSUE_TYPE_LABELS, REVIEW_STATUS, REVIEW_STATUS_LABELS } = require('./models');

class BaselineError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BaselineError';
    this.code = code;
  }
}

class BaselineManager {
  constructor(storeDir) {
    this.storeDir = storeDir || path.join(process.cwd(), '.bbcheck');
    this.baselinesDir = path.join(this.storeDir, 'baselines');
    this._ensureBaselinesDir();
  }

  _ensureBaselinesDir() {
    if (!fs.existsSync(this.baselinesDir)) {
      try {
        fs.mkdirSync(this.baselinesDir, { recursive: true });
      } catch (e) {
        throw new BaselineError(
          `无法创建基线存储目录: ${this.baselinesDir} — ${e.message}`,
          'STORAGE_NOT_WRITABLE'
        );
      }
    }
    try {
      fs.accessSync(this.baselinesDir, fs.constants.W_OK);
    } catch (e) {
      throw new BaselineError(
        `基线存储目录不可写: ${this.baselinesDir}`,
        'STORAGE_NOT_WRITABLE'
      );
    }
  }

  _baselinePath(name) {
    return path.join(this.baselinesDir, `${name}.json`);
  }

  _buildIssueKey(issue) {
    const section = (issue.details && issue.details.section) || '';
    const targetPath = issue.targetPath || '';
    const message = issue.message || '';
    return `${issue.type}::${targetPath}::${section}::${message}`;
  }

  save(name, scanResult, options = {}) {
    if (!name || typeof name !== 'string' || name.trim() === '') {
      throw new BaselineError('基线名称不能为空', 'EMPTY_NAME');
    }
    if (!/^[a-zA-Z0-9_\-.]+$/.test(name)) {
      throw new BaselineError(
        `基线名称 "${name}" 包含非法字符，仅允许字母、数字、下划线、连字符、点`,
        'INVALID_NAME'
      );
    }
    if (!scanResult) {
      throw new BaselineError('没有激活的批次，请先运行 scan 或 resume', 'NO_ACTIVE_BATCH');
    }

    const filePath = this._baselinePath(name);
    let overwritten = false;
    let previousData = null;

    if (fs.existsSync(filePath)) {
      if (!options.force) {
        throw new BaselineError(
          `同名基线 "${name}" 已存在，使用 --force 覆盖`,
          'DUPLICATE_NAME'
        );
      }
      overwritten = true;
      try {
        previousData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch (_) {
        previousData = null;
      }
    }

    const baselineData = {
      name: name,
      createdAt: new Date().toISOString(),
      sourceBatchId: scanResult.batchId,
      rulePath: scanResult.rulePath || null,
      targetDir: scanResult.targetDir || null,
      issueCount: scanResult.issues.length,
      summary: scanResult.summary || {},
      issues: scanResult.issues.map(i => ({
        id: i.id,
        type: i.type,
        severity: i.severity,
        message: i.message,
        targetPath: i.targetPath || null,
        expected: i.expected || null,
        actual: i.actual || null,
        details: i.details || {},
        reviewStatus: i.reviewStatus || REVIEW_STATUS.PENDING,
        handler: i.handler || null,
        assignee: i.assignee || null,
        remark: i.remark || null
      }))
    };

    try {
      const tmpFile = filePath + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(baselineData, null, 2), 'utf-8');
      fs.renameSync(tmpFile, filePath);
    } catch (e) {
      throw new BaselineError(
        `写入基线文件失败: ${e.message}`,
        'STORAGE_NOT_WRITABLE'
      );
    }

    return {
      name,
      overwritten,
      previousData,
      issueCount: scanResult.issues.length
    };
  }

  diff(name, currentScanResult) {
    if (!name || typeof name !== 'string' || name.trim() === '') {
      throw new BaselineError('基线名称不能为空', 'EMPTY_NAME');
    }
    if (!currentScanResult) {
      throw new BaselineError('没有激活的批次，请先运行 scan 或 resume', 'NO_ACTIVE_BATCH');
    }

    const filePath = this._baselinePath(name);
    if (!fs.existsSync(filePath)) {
      throw new BaselineError(
        `基线 "${name}" 不存在`,
        'NOT_FOUND'
      );
    }

    let baselineData;
    try {
      baselineData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      throw new BaselineError(
        `基线文件 "${name}" 已损坏: ${e.message}`,
        'CORRUPTED'
      );
    }

    if (baselineData.rulePath && currentScanResult.rulePath &&
        path.resolve(baselineData.rulePath) !== path.resolve(currentScanResult.rulePath)) {
      throw new BaselineError(
        `规则文件不匹配: 基线使用 "${baselineData.rulePath}"，当前批次使用 "${currentScanResult.rulePath}"`,
        'RULE_MISMATCH'
      );
    }

    if (baselineData.targetDir && currentScanResult.targetDir &&
        path.resolve(baselineData.targetDir) !== path.resolve(currentScanResult.targetDir)) {
      throw new BaselineError(
        `扫描目录不匹配: 基线来自 "${baselineData.targetDir}"，当前批次为 "${currentScanResult.targetDir}"`,
        'DIRECTORY_MISMATCH'
      );
    }

    const baselineMap = new Map();
    for (const issue of baselineData.issues) {
      const key = this._buildIssueKey(issue);
      if (!baselineMap.has(key)) baselineMap.set(key, []);
      baselineMap.get(key).push(issue);
    }

    const currentMap = new Map();
    for (const issue of currentScanResult.issues) {
      const key = this._buildIssueKey(issue);
      if (!currentMap.has(key)) currentMap.set(key, []);
      currentMap.get(key).push(issue);
    }

    const added = [];
    const removed = [];
    const changed = [];
    const unchanged = [];

    for (const [key, currentIssues] of currentMap.entries()) {
      const baselineIssues = baselineMap.get(key);
      if (!baselineIssues) {
        for (const ci of currentIssues) {
          added.push({ key, current: ci });
        }
      } else {
        const bLen = baselineIssues.length;
        const cLen = currentIssues.length;
        const maxLen = Math.max(bLen, cLen);
        for (let i = 0; i < maxLen; i++) {
          const baselineIssue = i < bLen ? baselineIssues[i] : null;
          const currentIssue = i < cLen ? currentIssues[i] : null;
          if (baselineIssue && currentIssue) {
            const changes = [];
            if (baselineIssue.reviewStatus !== currentIssue.reviewStatus) {
              changes.push({
                field: 'reviewStatus',
                from: baselineIssue.reviewStatus,
                to: currentIssue.reviewStatus,
                fromLabel: REVIEW_STATUS_LABELS[baselineIssue.reviewStatus] || baselineIssue.reviewStatus,
                toLabel: REVIEW_STATUS_LABELS[currentIssue.reviewStatus] || currentIssue.reviewStatus
              });
            }
            if (baselineIssue.assignee !== currentIssue.assignee) {
              changes.push({
                field: 'assignee',
                from: baselineIssue.assignee,
                to: currentIssue.assignee
              });
            }
            if (baselineIssue.remark !== currentIssue.remark) {
              changes.push({
                field: 'remark',
                from: baselineIssue.remark,
                to: currentIssue.remark
              });
            }
            if (baselineIssue.severity !== currentIssue.severity) {
              changes.push({
                field: 'severity',
                from: baselineIssue.severity,
                to: currentIssue.severity
              });
            }
            if (baselineIssue.message !== currentIssue.message) {
              changes.push({
                field: 'message',
                from: baselineIssue.message,
                to: currentIssue.message
              });
            }

            if (changes.length > 0) {
              changed.push({ key, baseline: baselineIssue, current: currentIssue, changes });
            } else {
              unchanged.push({ key, baseline: baselineIssue, current: currentIssue });
            }
          } else if (currentIssue) {
            added.push({ key, current: currentIssue });
          } else if (baselineIssue) {
            removed.push({ key, baseline: baselineIssue });
          }
        }
      }
    }

    for (const [key, baselineIssues] of baselineMap.entries()) {
      if (!currentMap.has(key)) {
        for (const bi of baselineIssues) {
          removed.push({ key, baseline: bi });
        }
      }
    }

    return {
      baselineName: name,
      baselineCreatedAt: baselineData.createdAt,
      baselineIssueCount: baselineData.issues.length,
      currentBatchId: currentScanResult.batchId,
      currentIssueCount: currentScanResult.issues.length,
      added,
      removed,
      changed,
      unchanged,
      summary: {
        added: added.length,
        removed: removed.length,
        changed: changed.length,
        unchanged: unchanged.length
      }
    };
  }

  list() {
    if (!fs.existsSync(this.baselinesDir)) {
      return [];
    }

    const entries = [];
    try {
      const files = fs.readdirSync(this.baselinesDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const filePath = path.join(this.baselinesDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          entries.push({
            name: data.name || path.basename(file, '.json'),
            createdAt: data.createdAt || null,
            sourceBatchId: data.sourceBatchId || null,
            rulePath: data.rulePath || null,
            targetDir: data.targetDir || null,
            issueCount: data.issueCount || 0
          });
        } catch (_) {
          entries.push({
            name: path.basename(file, '.json'),
            corrupted: true
          });
        }
      }
    } catch (e) {
      throw new BaselineError(
        `读取基线目录失败: ${e.message}`,
        'STORAGE_NOT_WRITABLE'
      );
    }

    entries.sort((a, b) => {
      if (a.corrupted && !b.corrupted) return 1;
      if (!a.corrupted && b.corrupted) return -1;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });

    return entries;
  }

  exportBaseline(name, outputPath) {
    if (!name || typeof name !== 'string' || name.trim() === '') {
      throw new BaselineError('基线名称不能为空', 'EMPTY_NAME');
    }

    const filePath = this._baselinePath(name);
    if (!fs.existsSync(filePath)) {
      throw new BaselineError(
        `基线 "${name}" 不存在`,
        'NOT_FOUND'
      );
    }

    let baselineData;
    try {
      baselineData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      throw new BaselineError(
        `基线文件 "${name}" 已损坏: ${e.message}`,
        'CORRUPTED'
      );
    }

    const absOutput = path.resolve(outputPath);
    const outputDir = path.dirname(absOutput);
    if (!fs.existsSync(outputDir)) {
      try {
        fs.mkdirSync(outputDir, { recursive: true });
      } catch (e) {
        throw new BaselineError(
          `无法创建输出目录: ${outputDir} — ${e.message}`,
          'STORAGE_NOT_WRITABLE'
        );
      }
    }

    const exportData = {
      _meta: {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        type: 'bbcheck-baseline'
      },
      baseline: baselineData
    };

    try {
      const tmpFile = absOutput + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(exportData, null, 2), 'utf-8');
      fs.renameSync(tmpFile, absOutput);
    } catch (e) {
      throw new BaselineError(
        `写入导出文件失败: ${e.message}`,
        'STORAGE_NOT_WRITABLE'
      );
    }

    return {
      name,
      outputPath: absOutput,
      issueCount: baselineData.issues ? baselineData.issues.length : 0
    };
  }

  importBaseline(filePath, options = {}) {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
      throw new BaselineError(
        `导入文件不存在: ${absPath}`,
        'FILE_NOT_FOUND'
      );
    }

    let importData;
    try {
      const raw = fs.readFileSync(absPath, 'utf-8');
      importData = JSON.parse(raw);
    } catch (e) {
      throw new BaselineError(
        `导入文件已损坏或不是有效的 JSON: ${e.message}`,
        'CORRUPTED'
      );
    }

    if (!importData._meta || importData._meta.type !== 'bbcheck-baseline') {
      if (importData.name && importData.issues && Array.isArray(importData.issues)) {
        importData = { _meta: { version: '1.0', type: 'bbcheck-baseline' }, baseline: importData };
      } else {
        throw new BaselineError(
          '导入文件不是有效的 bbcheck 基线文件（缺少 _meta.type 标识）',
          'CORRUPTED'
        );
      }
    }

    const baselineData = importData.baseline;
    if (!baselineData || !baselineData.name || !Array.isArray(baselineData.issues)) {
      throw new BaselineError(
        '导入的基线数据缺少必要字段 (name, issues)',
        'CORRUPTED'
      );
    }

    const name = options.name || baselineData.name;
    if (!/^[a-zA-Z0-9_\-.]+$/.test(name)) {
      throw new BaselineError(
        `基线名称 "${name}" 包含非法字符，仅允许字母、数字、下划线、连字符、点`,
        'INVALID_NAME'
      );
    }

    const targetPath = this._baselinePath(name);
    let overwritten = false;
    let previousData = null;

    if (fs.existsSync(targetPath)) {
      if (!options.force) {
        throw new BaselineError(
          `同名基线 "${name}" 已存在，使用 --force 覆盖`,
          'DUPLICATE_NAME'
        );
      }
      overwritten = true;
      try {
        previousData = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
      } catch (_) {
        previousData = null;
      }
    }

    baselineData.importedFrom = absPath;
    baselineData.importedAt = new Date().toISOString();
    if (options.name) {
      baselineData.originalName = baselineData.name;
      baselineData.name = options.name;
    }

    try {
      const tmpFile = targetPath + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(baselineData, null, 2), 'utf-8');
      fs.renameSync(tmpFile, targetPath);
    } catch (e) {
      throw new BaselineError(
        `写入基线文件失败: ${e.message}`,
        'STORAGE_NOT_WRITABLE'
      );
    }

    return {
      name,
      overwritten,
      previousData,
      issueCount: baselineData.issues.length
    };
  }

  deleteBaseline(name) {
    const filePath = this._baselinePath(name);
    if (!fs.existsSync(filePath)) {
      throw new BaselineError(
        `基线 "${name}" 不存在`,
        'NOT_FOUND'
      );
    }
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      throw new BaselineError(
        `删除基线文件失败: ${e.message}`,
        'STORAGE_NOT_WRITABLE'
      );
    }
    return true;
  }

  loadBaseline(name) {
    const filePath = this._baselinePath(name);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      throw new BaselineError(
        `基线文件 "${name}" 已损坏: ${e.message}`,
        'CORRUPTED'
      );
    }
  }

  exportDiffAsJSON(diffResult, outputPath) {
    const output = {
      _meta: {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        type: 'bbcheck-baseline-diff'
      },
      diff: diffResult
    };
    const absOutput = path.resolve(outputPath);
    const tmpFile = absOutput + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(output, null, 2), 'utf-8');
    fs.renameSync(tmpFile, absOutput);
    return { type: 'json', outputPath: absOutput };
  }

  exportDiffAsCSV(diffResult, outputPath) {
    const rows = [];
    rows.push([
      '差异标签',
      '问题ID',
      '类型',
      '严重程度',
      '基线状态',
      '当前状态',
      '基线负责人',
      '当前负责人',
      '基线备注',
      '当前备注',
      '目标路径',
      '描述',
      '变化字段'
    ]);

    for (const item of diffResult.added) {
      const c = item.current;
      rows.push([
        '新增',
        c.id,
        ISSUE_TYPE_LABELS[c.type] || c.type,
        c.severity,
        '-',
        REVIEW_STATUS_LABELS[c.reviewStatus] || c.reviewStatus,
        '-',
        c.assignee || '-',
        '-',
        c.remark || '-',
        c.targetPath || '-',
        c.message || '-',
        '-'
      ]);
    }

    for (const item of diffResult.removed) {
      const b = item.baseline;
      rows.push([
        '已消失',
        b.id,
        ISSUE_TYPE_LABELS[b.type] || b.type,
        b.severity,
        REVIEW_STATUS_LABELS[b.reviewStatus] || b.reviewStatus,
        '-',
        b.assignee || '-',
        '-',
        b.remark || '-',
        '-',
        b.targetPath || '-',
        b.message || '-',
        '-'
      ]);
    }

    for (const item of diffResult.changed) {
      const b = item.baseline;
      const c = item.current;
      const changedFields = item.changes.map(ch => ch.field).join(', ');
      rows.push([
        '变化',
        c.id,
        ISSUE_TYPE_LABELS[c.type] || c.type,
        c.severity,
        REVIEW_STATUS_LABELS[b.reviewStatus] || b.reviewStatus,
        REVIEW_STATUS_LABELS[c.reviewStatus] || c.reviewStatus,
        b.assignee || '-',
        c.assignee || '-',
        b.remark || '-',
        c.remark || '-',
        c.targetPath || '-',
        c.message || '-',
        changedFields
      ]);
    }

    for (const item of diffResult.unchanged) {
      const c = item.current;
      rows.push([
        '未变',
        c.id,
        ISSUE_TYPE_LABELS[c.type] || c.type,
        c.severity,
        REVIEW_STATUS_LABELS[c.reviewStatus] || c.reviewStatus,
        REVIEW_STATUS_LABELS[c.reviewStatus] || c.reviewStatus,
        c.assignee || '-',
        c.assignee || '-',
        c.remark || '-',
        c.remark || '-',
        c.targetPath || '-',
        c.message || '-',
        '-'
      ]);
    }

    const csv = rows.map(r => r.map(c => this._escapeCsv(c)).join(',')).join('\r\n');
    const bom = '\uFEFF';
    const absOutput = path.resolve(outputPath);
    fs.writeFileSync(absOutput, bom + csv, 'utf-8');
    return { type: 'csv', outputPath: absOutput };
  }

  exportDiffAsHTML(diffResult, outputPath) {
    const html = this._buildDiffHTML(diffResult);
    const absOutput = path.resolve(outputPath);
    fs.writeFileSync(absOutput, html, 'utf-8');
    return { type: 'html', outputPath: absOutput };
  }

  _escapeCsv(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  _escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  _formatTime(isoString) {
    if (!isoString) return '-';
    try {
      const d = new Date(isoString);
      const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch (_) {
      return isoString;
    }
  }

  _buildDiffHTML(diffResult) {
    const s = diffResult.summary;
    const total = s.added + s.removed + s.changed + s.unchanged;

    let rowsHTML = '';
    for (const item of diffResult.added) {
      const c = item.current;
      rowsHTML += `<tr class="diff-added">
        <td><span class="tag tag-added">新增</span></td>
        <td><code>${this._escapeHTML(c.id.slice(0, 16))}…</code></td>
        <td>${this._escapeHTML(ISSUE_TYPE_LABELS[c.type] || c.type)}</td>
        <td>${this._escapeHTML(c.severity)}</td>
        <td>-</td>
        <td>${this._escapeHTML(REVIEW_STATUS_LABELS[c.reviewStatus] || c.reviewStatus)}</td>
        <td>-</td>
        <td>${this._escapeHTML(c.assignee || '-')}</td>
        <td>-</td>
        <td>${this._escapeHTML(c.remark || '-')}</td>
        <td><code>${this._escapeHTML(c.targetPath || '-')}</code></td>
        <td>${this._escapeHTML(c.message || '-')}</td>
      </tr>`;
    }
    for (const item of diffResult.removed) {
      const b = item.baseline;
      rowsHTML += `<tr class="diff-removed">
        <td><span class="tag tag-removed">已消失</span></td>
        <td><code>${this._escapeHTML(b.id.slice(0, 16))}…</code></td>
        <td>${this._escapeHTML(ISSUE_TYPE_LABELS[b.type] || b.type)}</td>
        <td>${this._escapeHTML(b.severity)}</td>
        <td>${this._escapeHTML(REVIEW_STATUS_LABELS[b.reviewStatus] || b.reviewStatus)}</td>
        <td>-</td>
        <td>${this._escapeHTML(b.assignee || '-')}</td>
        <td>-</td>
        <td>${this._escapeHTML(b.remark || '-')}</td>
        <td>-</td>
        <td><code>${this._escapeHTML(b.targetPath || '-')}</code></td>
        <td>${this._escapeHTML(b.message || '-')}</td>
      </tr>`;
    }
    for (const item of diffResult.changed) {
      const b = item.baseline;
      const c = item.current;
      const changedFields = item.changes.map(ch => ch.field).join(', ');
      rowsHTML += `<tr class="diff-changed">
        <td><span class="tag tag-changed">变化</span></td>
        <td><code>${this._escapeHTML(c.id.slice(0, 16))}…</code></td>
        <td>${this._escapeHTML(ISSUE_TYPE_LABELS[c.type] || c.type)}</td>
        <td>${this._escapeHTML(c.severity)}</td>
        <td>${this._escapeHTML(REVIEW_STATUS_LABELS[b.reviewStatus] || b.reviewStatus)}</td>
        <td>${this._escapeHTML(REVIEW_STATUS_LABELS[c.reviewStatus] || c.reviewStatus)}</td>
        <td>${this._escapeHTML(b.assignee || '-')}</td>
        <td>${this._escapeHTML(c.assignee || '-')}</td>
        <td>${this._escapeHTML(b.remark || '-')}</td>
        <td>${this._escapeHTML(c.remark || '-')}</td>
        <td><code>${this._escapeHTML(c.targetPath || '-')}</code></td>
        <td>${this._escapeHTML(c.message || '-')}</td>
        <td>${this._escapeHTML(changedFields)}</td>
      </tr>`;
    }
    for (const item of diffResult.unchanged) {
      const c = item.current;
      rowsHTML += `<tr class="diff-unchanged">
        <td><span class="tag tag-unchanged">未变</span></td>
        <td><code>${this._escapeHTML(c.id.slice(0, 16))}…</code></td>
        <td>${this._escapeHTML(ISSUE_TYPE_LABELS[c.type] || c.type)}</td>
        <td>${this._escapeHTML(c.severity)}</td>
        <td>${this._escapeHTML(REVIEW_STATUS_LABELS[c.reviewStatus] || c.reviewStatus)}</td>
        <td>${this._escapeHTML(REVIEW_STATUS_LABELS[c.reviewStatus] || c.reviewStatus)}</td>
        <td>${this._escapeHTML(c.assignee || '-')}</td>
        <td>${this._escapeHTML(c.assignee || '-')}</td>
        <td>${this._escapeHTML(c.remark || '-')}</td>
        <td>${this._escapeHTML(c.remark || '-')}</td>
        <td><code>${this._escapeHTML(c.targetPath || '-')}</code></td>
        <td>${this._escapeHTML(c.message || '-')}</td>
      </tr>`;
    }

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>基线差异对比报告</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f7fa; color: #2c3e50; padding: 32px; line-height: 1.6; }
  .container { max-width: 1500px; margin: 0 auto; }
  h1 { font-size: 28px; margin-bottom: 8px; color: #1a365d; }
  .subtitle { color: #718096; margin-bottom: 32px; font-size: 14px; }
  .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 32px; }
  .stat-card { background: white; padding: 20px; border-radius: 8px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .stat-value { font-size: 36px; font-weight: 700; }
  .stat-label { font-size: 13px; color: #718096; margin-top: 4px; }
  .added-card { border-top: 4px solid #48bb78; }
  .added-card .stat-value { color: #38a169; }
  .removed-card { border-top: 4px solid #fc8181; }
  .removed-card .stat-value { color: #e53e3e; }
  .changed-card { border-top: 4px solid #ed8936; }
  .changed-card .stat-value { color: #dd6b20; }
  .unchanged-card { border-top: 4px solid #a0aec0; }
  .unchanged-card .stat-value { color: #718096; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  thead { background: #1a365d; color: white; }
  th { padding: 12px 10px; text-align: left; font-weight: 600; font-size: 12px; white-space: nowrap; }
  td { padding: 10px; border-bottom: 1px solid #edf2f7; vertical-align: top; font-size: 13px; }
  .tag { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .tag-added { background: #c6f6d5; color: #22543d; }
  .tag-removed { background: #fed7d7; color: #742a2a; }
  .tag-changed { background: #feebc8; color: #7b341e; }
  .tag-unchanged { background: #edf2f7; color: #4a5568; }
  .diff-added { background: #f0fff4; }
  .diff-removed { background: #fff5f5; }
  .diff-changed { background: #fffaf0; }
  .diff-unchanged { background: #f7fafc; opacity: 0.7; }
  code { font-family: "SF Mono", Monaco, Consolas, monospace; background: #edf2f7; padding: 2px 6px; border-radius: 4px; font-size: 11px; }
  footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid #e2e8f0; color: #a0aec0; font-size: 12px; text-align: center; }
</style>
</head>
<body>
<div class="container">
  <h1>📊 基线差异对比报告</h1>
  <div class="subtitle">
    基线: ${this._escapeHTML(diffResult.baselineName)} (创建于 ${this._formatTime(diffResult.baselineCreatedAt)})
    &nbsp;|&nbsp; 当前批次: ${this._escapeHTML(diffResult.currentBatchId)}
    &nbsp;|&nbsp; 生成时间: ${this._formatTime(new Date().toISOString())}
  </div>

  <div class="stats-row">
    <div class="stat-card added-card">
      <div class="stat-value">${s.added}</div>
      <div class="stat-label">新增</div>
    </div>
    <div class="stat-card removed-card">
      <div class="stat-value">${s.removed}</div>
      <div class="stat-label">已消失</div>
    </div>
    <div class="stat-card changed-card">
      <div class="stat-value">${s.changed}</div>
      <div class="stat-label">变化</div>
    </div>
    <div class="stat-card unchanged-card">
      <div class="stat-value">${s.unchanged}</div>
      <div class="stat-label">未变</div>
    </div>
  </div>

  <h2 style="font-size:20px;font-weight:600;margin:24px 0 16px;color:#2d3748;">差异明细 (共 ${total} 条)</h2>
  <table>
    <thead>
      <tr>
        <th>差异标签</th>
        <th>问题ID</th>
        <th>类型</th>
        <th>严重</th>
        <th>基线状态</th>
        <th>当前状态</th>
        <th>基线负责人</th>
        <th>当前负责人</th>
        <th>基线备注</th>
        <th>当前备注</th>
        <th>路径</th>
        <th>描述</th>
        <th>变化字段</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHTML || '<tr><td colspan="13" style="text-align:center;padding:40px;color:#a0aec0">无差异</td></tr>'}
    </tbody>
  </table>

  <footer>
    本报告由 bid-binder-checker v1.0.0 生成 | 新增 ${s.added}、已消失 ${s.removed}、变化 ${s.changed}、未变 ${s.unchanged}
  </footer>
</div>
</body>
</html>`;
  }
}

module.exports = {
  BaselineManager,
  BaselineError
};
