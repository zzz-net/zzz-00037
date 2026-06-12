const ISSUE_TYPES = {
  MISSING_FILE: 'MISSING_FILE',
  NAMING_ERROR: 'NAMING_ERROR',
  DUPLICATE_VERSION: 'DUPLICATE_VERSION',
  ORDER_ERROR: 'ORDER_ERROR',
  PAGE_DISCONTINUITY: 'PAGE_DISCONTINUITY',
  UNTRACKED_FILE: 'UNTRACKED_FILE',
  EXPIRED_FIELD: 'EXPIRED_FIELD',
  MISSING_SIGNATURE: 'MISSING_SIGNATURE'
};

const ISSUE_TYPE_LABELS = {
  [ISSUE_TYPES.MISSING_FILE]: '缺失文件',
  [ISSUE_TYPES.NAMING_ERROR]: '命名错误',
  [ISSUE_TYPES.DUPLICATE_VERSION]: '重复版本',
  [ISSUE_TYPES.ORDER_ERROR]: '顺序异常',
  [ISSUE_TYPES.PAGE_DISCONTINUITY]: '页码不连续',
  [ISSUE_TYPES.UNTRACKED_FILE]: '未纳入规则',
  [ISSUE_TYPES.EXPIRED_FIELD]: '字段过期',
  [ISSUE_TYPES.MISSING_SIGNATURE]: '缺少签章'
};

const REVIEW_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  IGNORED: 'ignored'
};

const REVIEW_STATUS_LABELS = {
  [REVIEW_STATUS.PENDING]: '待补',
  [REVIEW_STATUS.CONFIRMED]: '已确认',
  [REVIEW_STATUS.IGNORED]: '忽略'
};

class Issue {
  constructor(data) {
    this.id = data.id || Issue.generateId();
    this.type = data.type;
    this.severity = data.severity || 'error';
    this.message = data.message;
    this.targetPath = data.targetPath || null;
    this.expected = data.expected || null;
    this.actual = data.actual || null;
    this.details = data.details || {};
    this.reviewStatus = data.reviewStatus || REVIEW_STATUS.PENDING;
    this.handler = data.handler || null;
    this.remark = data.remark || null;
    this.reviewHistory = data.reviewHistory || [];
  }

  static generateId() {
    return 'ISSUE_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  setReview(status, handler, remark = '') {
    const change = {
      from: this.reviewStatus,
      to: status,
      handler: handler,
      remark: remark,
      timestamp: new Date().toISOString()
    };
    this.reviewHistory.push(change);
    this.reviewStatus = status;
    this.handler = handler;
    this.remark = remark;
    return change;
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      severity: this.severity,
      message: this.message,
      targetPath: this.targetPath,
      expected: this.expected,
      actual: this.actual,
      details: this.details,
      reviewStatus: this.reviewStatus,
      handler: this.handler,
      remark: this.remark,
      reviewHistory: this.reviewHistory
    };
  }
}

class ScanResult {
  constructor(data = {}) {
    this.batchId = data.batchId || ScanResult.generateBatchId();
    this.scanTime = data.scanTime || new Date().toISOString();
    this.rulePath = data.rulePath || null;
    this.targetDir = data.targetDir || null;
    this.directorySignature = data.directorySignature || null;
    this.issues = (data.issues || []).map(i => new Issue(i));
    this.scannedFiles = data.scannedFiles || [];
    this.summary = data.summary || {
      total: 0,
      byType: {},
      byStatus: { pending: 0, confirmed: 0, ignored: 0 }
    };
  }

  static generateBatchId() {
    return 'BATCH_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  addIssue(issueData) {
    const issue = new Issue(issueData);
    this.issues.push(issue);
    this.recalculateSummary();
    return issue;
  }

  getIssueById(id) {
    return this.issues.find(i => i.id === id);
  }

  recalculateSummary() {
    this.summary.total = this.issues.length;
    this.summary.byType = {};
    this.summary.byStatus = { pending: 0, confirmed: 0, ignored: 0 };

    for (const issue of this.issues) {
      if (!this.summary.byType[issue.type]) {
        this.summary.byType[issue.type] = 0;
      }
      this.summary.byType[issue.type]++;
      this.summary.byStatus[issue.reviewStatus]++;
    }
  }

  toJSON() {
    this.recalculateSummary();
    return {
      batchId: this.batchId,
      scanTime: this.scanTime,
      rulePath: this.rulePath,
      targetDir: this.targetDir,
      directorySignature: this.directorySignature,
      issues: this.issues.map(i => i.toJSON()),
      scannedFiles: this.scannedFiles,
      summary: this.summary
    };
  }
}

module.exports = {
  ISSUE_TYPES,
  ISSUE_TYPE_LABELS,
  REVIEW_STATUS,
  REVIEW_STATUS_LABELS,
  Issue,
  ScanResult
};
