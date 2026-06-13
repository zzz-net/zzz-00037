const fs = require('fs');
const path = require('path');
const { ISSUE_TYPE_LABELS, REVIEW_STATUS, REVIEW_STATUS_LABELS } = require('./models');

class ExportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExportError';
  }
}

class Exporter {
  _escapeCsv(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  exportCSV(scanResult, outputPath) {
    const rows = [];
    const headers = [
      '问题ID',
      '类型',
      '严重程度',
      '复核状态',
      '处理人',
      '负责人',
      '备注',
      '目标路径',
      '描述',
      '期望',
      '实际',
      '章节',
      '扫描时间'
    ];
    rows.push(headers);

    for (const issue of scanResult.issues) {
      const section = (issue.details && issue.details.section) || '';
      rows.push([
        issue.id,
        ISSUE_TYPE_LABELS[issue.type] || issue.type,
        this._severityLabel(issue.severity),
        REVIEW_STATUS_LABELS[issue.reviewStatus] || issue.reviewStatus,
        issue.handler || '',
        issue.assignee || '',
        issue.remark || '',
        issue.targetPath || '',
        issue.message || '',
        issue.expected || '',
        issue.actual || '',
        section,
        scanResult.scanTime
      ]);
    }

    const summaryRow1 = [
      '=== 汇总 ===', '', '', '', '', '', '', '', '', '', '', '', ''
    ];
    rows.push(summaryRow1);
    rows.push([
      '问题总数',
      scanResult.summary.total,
      '',
      '待补',
      scanResult.summary.byStatus.pending || 0,
      '已确认',
      scanResult.summary.byStatus.confirmed || 0,
      '忽略',
      scanResult.summary.byStatus.ignored || 0,
      '', '', '', ''
    ]);
    rows.push(['按类型统计:', '', '', '', '', '', '', '', '', '', '', '', '']);
    for (const [type, count] of Object.entries(scanResult.summary.byType)) {
      rows.push([
        ISSUE_TYPE_LABELS[type] || type,
        count, '', '', '', '', '', '', '', '', '', '', ''
      ]);
    }
    rows.push(['', '', '', '', '', '', '', '', '', '', '', '', '']);
    rows.push([
      '批次ID', scanResult.batchId, '', '', '', '', '', '', '', '', '', '', ''
    ]);
    rows.push([
      '规则文件', scanResult.rulePath, '', '', '', '', '', '', '', '', '', '', ''
    ]);
    rows.push([
      '扫描目录', scanResult.targetDir, '', '', '', '', '', '', '', '', '', '', ''
    ]);

    const csv = rows.map(r => r.map(c => this._escapeCsv(c)).join(',')).join('\r\n');
    const bom = '\uFEFF';
    fs.writeFileSync(outputPath, bom + csv, 'utf-8');
    return {
      type: 'csv',
      outputPath,
      rows: rows.length - 1,
      issues: scanResult.issues.length
    };
  }

  _severityLabel(s) {
    return { error: '错误', warn: '警告', info: '提示' }[s] || s;
  }

  _severityClass(s) {
    return { error: 'sev-error', warn: 'sev-warn', info: 'sev-info' }[s] || '';
  }

  _statusClass(s) {
    return {
      [REVIEW_STATUS.PENDING]: 'st-pending',
      [REVIEW_STATUS.CONFIRMED]: 'st-confirmed',
      [REVIEW_STATUS.IGNORED]: 'st-ignored'
    }[s] || '';
  }

  exportHTML(scanResult, outputPath) {
    const byTypeStats = Object.entries(scanResult.summary.byType).map(([type, count]) => ({
      type,
      label: ISSUE_TYPE_LABELS[type] || type,
      count
    }));

    const byStatus = {
      pending: scanResult.summary.byStatus.pending || 0,
      confirmed: scanResult.summary.byStatus.confirmed || 0,
      ignored: scanResult.summary.byStatus.ignored || 0
    };

    const total = scanResult.summary.total;

    let issuesHTML = '';
    for (const issue of scanResult.issues) {
      const section = (issue.details && issue.details.section) || '-';
      const reviewHistoryHTML = issue.reviewHistory && issue.reviewHistory.length > 0
        ? '<div class="history">' +
            '<strong>历史:</strong><ul>' +
            issue.reviewHistory.map(h => {
              if (h.operator) {
                return `<li>[${this._formatTime(h.timestamp)}] 负责人: ${this._escapeHTML(h.from || '(无)')} → ${this._escapeHTML(h.to || '(无)')} by ${this._escapeHTML(h.operator)}${h.reason ? ' - ' + this._escapeHTML(h.reason) : ''}</li>`;
              }
              return `<li>[${this._formatTime(h.timestamp)}] ${this._statusBadge(h.from)} → ${this._statusBadge(h.to)}${h.handler ? ' by ' + this._escapeHTML(h.handler) : ''}${h.remark ? ' - ' + this._escapeHTML(h.remark) : ''}</li>`;
            }).join('') +
            '</ul></div>'
        : '';

      issuesHTML += `
        <tr class="issue-row ${this._statusClass(issue.reviewStatus)}">
          <td><code>${this._escapeHTML(issue.id.slice(0, 16))}…</code></td>
          <td><span class="type-label">${this._escapeHTML(ISSUE_TYPE_LABELS[issue.type] || issue.type)}</span></td>
          <td><span class="sev-badge ${this._severityClass(issue.severity)}">${this._severityLabel(issue.severity)}</span></td>
          <td>${this._statusBadge(issue.reviewStatus)}</td>
          <td>${this._escapeHTML(issue.handler || '-')}</td>
          <td>${this._escapeHTML(issue.assignee || '-')}</td>
          <td>${this._escapeHTML(issue.remark || '-')}</td>
          <td><code>${this._escapeHTML(section)}</code></td>
          <td><code>${this._escapeHTML(issue.targetPath || '-')}</code></td>
          <td>
            <div class="msg">${this._escapeHTML(issue.message || '')}</div>
            ${issue.expected ? `<div class="kv"><span class="k">期望:</span> <span class="v">${this._escapeHTML(String(issue.expected))}</span></div>` : ''}
            ${issue.actual ? `<div class="kv"><span class="k">实际:</span> <span class="v">${this._escapeHTML(String(issue.actual))}</span></div>` : ''}
            ${reviewHistoryHTML}
          </td>
        </tr>`;
    }

    const typeStatsHTML = byTypeStats.map(s =>
      `<div class="stat-card type-card">
        <div class="stat-value">${s.count}</div>
        <div class="stat-label">${this._escapeHTML(s.label)}</div>
      </div>`
    ).join('');

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>投标文件装订检查报告</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; background: #f5f7fa; color: #2c3e50; padding: 32px; line-height: 1.6; }
  .container { max-width: 1400px; margin: 0 auto; }
  h1 { font-size: 28px; margin-bottom: 8px; color: #1a365d; }
  .subtitle { color: #718096; margin-bottom: 32px; font-size: 14px; }
  .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .meta-card { background: white; padding: 16px 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); border-left: 4px solid #4299e1; }
  .meta-card .k { font-size: 12px; color: #718096; text-transform: uppercase; letter-spacing: 0.5px; }
  .meta-card .v { font-size: 15px; font-weight: 500; color: #2d3748; margin-top: 4px; word-break: break-all; }
  .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 32px; }
  .stat-card { background: white; padding: 20px; border-radius: 8px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .stat-value { font-size: 36px; font-weight: 700; }
  .stat-label { font-size: 13px; color: #718096; margin-top: 4px; }
  .total-card { border-top: 4px solid #805ad5; }
  .total-card .stat-value { color: #6b46c1; }
  .pending-card { border-top: 4px solid #ed8936; }
  .pending-card .stat-value { color: #dd6b20; }
  .confirmed-card { border-top: 4px solid #48bb78; }
  .confirmed-card .stat-value { color: #38a169; }
  .ignored-card { border-top: 4px solid #a0aec0; }
  .ignored-card .stat-value { color: #718096; }
  .section-title { font-size: 20px; font-weight: 600; margin: 32px 0 16px; color: #2d3748; display: flex; align-items: center; gap: 12px; }
  .section-title::before { content: ''; display: inline-block; width: 4px; height: 22px; background: #4299e1; border-radius: 2px; }
  .type-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 32px; }
  .type-card { border-top: 4px solid #e2e8f0; }
  .type-card .stat-value { font-size: 24px; color: #2d3748; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  thead { background: #1a365d; color: white; }
  th { padding: 14px 16px; text-align: left; font-weight: 600; font-size: 13px; white-space: nowrap; }
  td { padding: 14px 16px; border-bottom: 1px solid #edf2f7; vertical-align: top; font-size: 14px; }
  tbody tr:hover { background: #f7fafc; }
  .st-pending { background: #fffaf0; }
  .st-confirmed { background: #f0fff4; }
  .st-ignored { background: #f7fafc; opacity: 0.7; }
  .type-label { display: inline-block; background: #ebf8ff; color: #2b6cb0; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 500; }
  .sev-badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
  .sev-error { background: #fed7d7; color: #c53030; }
  .sev-warn { background: #feebc8; color: #c05621; }
  .sev-info { background: #bee3f8; color: #2b6cb0; }
  .status-badge { display: inline-block; padding: 3px 12px; border-radius: 14px; font-size: 12px; font-weight: 600; }
  .st-pending-badge { background: #fbd38d; color: #7b341e; }
  .st-confirmed-badge { background: #9ae6b4; color: #22543d; }
  .st-ignored-badge { background: #cbd5e0; color: #4a5568; }
  .msg { font-weight: 500; color: #2d3748; margin-bottom: 8px; }
  .kv { font-size: 13px; color: #4a5568; margin-top: 4px; }
  .kv .k { color: #718096; font-weight: 500; margin-right: 6px; }
  code { font-family: "SF Mono", Monaco, Consolas, monospace; background: #edf2f7; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
  .history { margin-top: 12px; padding: 10px 14px; background: #f7fafc; border-radius: 6px; font-size: 12px; color: #4a5568; }
  .history ul { margin-top: 6px; padding-left: 18px; }
  .history li { margin: 3px 0; }
  footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid #e2e8f0; color: #a0aec0; font-size: 12px; text-align: center; }
</style>
</head>
<body>
<div class="container">
  <h1>📋 投标文件装订检查报告</h1>
  <div class="subtitle">生成时间: ${this._formatTime(new Date().toISOString())}</div>

  <div class="meta-grid">
    <div class="meta-card">
      <div class="k">批次ID</div>
      <div class="v">${this._escapeHTML(scanResult.batchId)}</div>
    </div>
    <div class="meta-card">
      <div class="k">规则文件</div>
      <div class="v">${this._escapeHTML(scanResult.rulePath || '-')}</div>
    </div>
    <div class="meta-card">
      <div class="k">扫描目录</div>
      <div class="v">${this._escapeHTML(scanResult.targetDir || '-')}</div>
    </div>
    <div class="meta-card">
      <div class="k">扫描时间</div>
      <div class="v">${this._formatTime(scanResult.scanTime)}</div>
    </div>
  </div>

  <div class="stats-row">
    <div class="stat-card total-card">
      <div class="stat-value">${total}</div>
      <div class="stat-label">问题总数</div>
    </div>
    <div class="stat-card pending-card">
      <div class="stat-value">${byStatus.pending}</div>
      <div class="stat-label">待补 (${total > 0 ? Math.round(byStatus.pending / total * 100) : 0}%)</div>
    </div>
    <div class="stat-card confirmed-card">
      <div class="stat-value">${byStatus.confirmed}</div>
      <div class="stat-label">已确认 (${total > 0 ? Math.round(byStatus.confirmed / total * 100) : 0}%)</div>
    </div>
    <div class="stat-card ignored-card">
      <div class="stat-value">${byStatus.ignored}</div>
      <div class="stat-label">忽略 (${total > 0 ? Math.round(byStatus.ignored / total * 100) : 0}%)</div>
    </div>
  </div>

  <h2 class="section-title">按问题类型分布</h2>
  <div class="type-stats">
    ${typeStatsHTML}
  </div>

  <h2 class="section-title">问题明细 (${scanResult.issues.length} 条)</h2>
  <table>
    <thead>
      <tr>
        <th style="width:130px">问题ID</th>
        <th style="width:110px">类型</th>
        <th style="width:80px">严重</th>
        <th style="width:90px">状态</th>
        <th style="width:100px">处理人</th>
        <th style="width:100px">负责人</th>
        <th style="width:120px">备注</th>
        <th style="width:120px">章节</th>
        <th style="width:200px">路径</th>
        <th>详细说明</th>
      </tr>
    </thead>
    <tbody>
      ${issuesHTML || '<tr><td colspan="10" style="text-align:center;padding:40px;color:#a0aec0">🎉 没有发现任何问题</td></tr>'}
    </tbody>
  </table>

  <footer>
    本报告由 bid-binder-checker v1.0.0 生成 | 共 ${scanResult.issues.length} 个问题，其中待补 ${byStatus.pending}、已确认 ${byStatus.confirmed}、忽略 ${byStatus.ignored}
  </footer>
</div>
</body>
</html>`;

    fs.writeFileSync(outputPath, html, 'utf-8');
    return {
      type: 'html',
      outputPath,
      issues: scanResult.issues.length
    };
  }

  exportJSON(scanResult, outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify(scanResult.toJSON(), null, 2), 'utf-8');
    return {
      type: 'json',
      outputPath,
      issues: scanResult.issues.length
    };
  }

  exportAuto(scanResult, outputPath) {
    const ext = path.extname(outputPath).toLowerCase();
    switch (ext) {
      case '.csv':
        return this.exportCSV(scanResult, outputPath);
      case '.html':
      case '.htm':
        return this.exportHTML(scanResult, outputPath);
      case '.json':
        return this.exportJSON(scanResult, outputPath);
      default:
        throw new ExportError(`不支持的导出格式: ${ext}，请使用 .csv, .html 或 .json`);
    }
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

  _statusBadge(status) {
    const cls = {
      [REVIEW_STATUS.PENDING]: 'st-pending-badge',
      [REVIEW_STATUS.CONFIRMED]: 'st-confirmed-badge',
      [REVIEW_STATUS.IGNORED]: 'st-ignored-badge'
    }[status] || '';
    return `<span class="status-badge ${cls}">${this._escapeHTML(REVIEW_STATUS_LABELS[status] || status)}</span>`;
  }

  _formatTime(isoString) {
    if (!isoString) return '-';
    try {
      const d = new Date(isoString);
      const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch (e) {
      return isoString;
    }
  }
}

module.exports = {
  Exporter,
  ExportError
};
