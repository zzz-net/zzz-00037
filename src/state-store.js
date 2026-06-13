const fs = require('fs');
const path = require('path');
const { ScanResult, REVIEW_STATUS } = require('./models');

class EmptyUndoStackError extends Error {
  constructor() {
    super('撤销栈为空，没有可撤销的操作');
    this.name = 'EmptyUndoStackError';
  }
}

class StateStore {
  constructor(storeDir = null) {
    this.storeDir = storeDir || path.join(process.cwd(), '.bbcheck');
    this.dataFile = path.join(this.storeDir, 'state.json');
    this.indexFile = path.join(this.storeDir, 'index.json');
    this.activeBatchFile = path.join(this.storeDir, 'active-batch');
    this.undoStackFile = path.join(this.storeDir, 'undo-stack.json');
    this._cache = null;
    this._undoStack = [];
    this._initStoreDir();
    this._loadUndoStack();
  }

  _loadUndoStack() {
    if (fs.existsSync(this.undoStackFile)) {
      try {
        const raw = fs.readFileSync(this.undoStackFile, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this._undoStack = parsed;
        }
      } catch (e) {
        this._undoStack = [];
      }
    }
  }

  _saveUndoStack() {
    try {
      fs.writeFileSync(this.undoStackFile, JSON.stringify(this._undoStack, null, 2), 'utf-8');
    } catch (e) {
    }
  }

  _pushUndo(action) {
    this._undoStack.push(action);
    if (this._undoStack.length > 200) {
      this._undoStack = this._undoStack.slice(-200);
    }
    this._saveUndoStack();
  }

  _popUndo() {
    const action = this._undoStack.pop();
    this._saveUndoStack();
    return action;
  }

  _initStoreDir() {
    if (!fs.existsSync(this.storeDir)) {
      fs.mkdirSync(this.storeDir, { recursive: true });
    }
    if (!fs.existsSync(this.dataFile)) {
      fs.writeFileSync(this.dataFile, JSON.stringify({ batches: {} }, null, 2), 'utf-8');
    }
    if (!fs.existsSync(this.indexFile)) {
      fs.writeFileSync(this.indexFile, JSON.stringify({
        batches: [],
        directoryIndex: {}
      }, null, 2), 'utf-8');
    }
  }

  _loadIndex() {
    try {
      const raw = fs.readFileSync(this.indexFile, 'utf-8');
      return JSON.parse(raw);
    } catch (e) {
      return { batches: [], directoryIndex: {} };
    }
  }

  _saveIndex(index) {
    fs.writeFileSync(this.indexFile, JSON.stringify(index, null, 2), 'utf-8');
  }

  _loadAllData() {
    try {
      const raw = fs.readFileSync(this.dataFile, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed.batches) parsed.batches = {};
      return parsed;
    } catch (e) {
      return { batches: {} };
    }
  }

  _saveAllData(data) {
    const tmpFile = this.dataFile + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpFile, this.dataFile);
  }

  _getBatchPath(batchId) {
    return path.join(this.storeDir, `batch_${batchId}.json`);
  }

  _saveBatchSeparate(batchId, scanResult) {
    const batchPath = this._getBatchPath(batchId);
    fs.writeFileSync(batchPath, JSON.stringify(scanResult.toJSON(), null, 2), 'utf-8');
  }

  _loadBatchSeparate(batchId) {
    const batchPath = this._getBatchPath(batchId);
    if (!fs.existsSync(batchPath)) return null;
    try {
      const raw = fs.readFileSync(batchPath, 'utf-8');
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  saveBatch(scanResult) {
    const data = this._loadAllData();
    const index = this._loadIndex();

    const existing = data.batches[scanResult.batchId];
    if (existing) {
      const before = JSON.parse(JSON.stringify(existing));
      this._pushUndo({
        type: 'UPDATE_BATCH',
        batchId: scanResult.batchId,
        before: before
      });
    } else {
      this._pushUndo({
        type: 'NEW_BATCH',
        batchId: scanResult.batchId
      });
    }

    data.batches[scanResult.batchId] = scanResult.toJSON();
    this._saveAllData(data);
    this._saveBatchSeparate(scanResult.batchId, scanResult);

    const idx = index.batches.findIndex(b => b.batchId === scanResult.batchId);
    const entry = {
      batchId: scanResult.batchId,
      rulePath: scanResult.rulePath,
      targetDir: scanResult.targetDir,
      directorySignature: scanResult.directorySignature,
      scanTime: scanResult.scanTime,
      lastModified: new Date().toISOString(),
      totalIssues: scanResult.summary.total,
      pendingIssues: scanResult.summary.byStatus.pending
    };
    if (idx >= 0) {
      index.batches[idx] = entry;
    } else {
      index.batches.push(entry);
    }

    if (scanResult.targetDir) {
      const sig = scanResult.directorySignature || '';
      if (!index.directoryIndex[scanResult.targetDir]) {
        index.directoryIndex[scanResult.targetDir] = {
          signature: sig,
          batches: [],
          lastScanTime: scanResult.scanTime
        };
      } else {
        index.directoryIndex[scanResult.targetDir].signature = sig;
        index.directoryIndex[scanResult.targetDir].lastScanTime = scanResult.scanTime;
      }
      if (!index.directoryIndex[scanResult.targetDir].batches.includes(scanResult.batchId)) {
        index.directoryIndex[scanResult.targetDir].batches.push(scanResult.batchId);
      }
    }
    index.batches.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    this._saveIndex(index);
    this.setActiveBatch(scanResult.batchId);

    return scanResult.batchId;
  }

  loadBatch(batchId) {
    let batchData = this._loadBatchSeparate(batchId);
    if (!batchData) {
      const data = this._loadAllData();
      batchData = data.batches[batchId] || null;
    }
    if (!batchData) return null;
    return new ScanResult(batchData);
  }

  hasBatchForDirectory(targetDir, directorySignature = null) {
    const index = this._loadIndex();
    const absDir = path.resolve(targetDir);
    const entry = index.directoryIndex[absDir];
    if (!entry || !Array.isArray(entry.batches) || entry.batches.length === 0) {
      return { exists: false };
    }
    const result = {
      exists: true,
      lastScanTime: entry.lastScanTime,
      batches: entry.batches
    };
    if (directorySignature && entry.signature && entry.signature !== directorySignature) {
      result.directoryChanged = true;
    }
    return result;
  }

  setActiveBatch(batchId) {
    if (!batchId || typeof batchId !== 'string') return;
    fs.writeFileSync(this.activeBatchFile, batchId, 'utf-8');
  }

  getActiveBatchId() {
    if (!fs.existsSync(this.activeBatchFile)) return null;
    const id = fs.readFileSync(this.activeBatchFile, 'utf-8').trim();
    if (!id || id === 'undefined' || id === 'null') return null;
    return id;
  }

  getActiveBatch() {
    const id = this.getActiveBatchId();
    if (!id) return null;
    return this.loadBatch(id);
  }

  listBatches(limit = 20) {
    const index = this._loadIndex();
    return index.batches.slice(0, limit);
  }

  updateIssueStatus(batchId, issueId, status, handler, remark = '') {
    if (!Object.values(REVIEW_STATUS).includes(status)) {
      throw new Error(`无效的复核状态: ${status}`);
    }
    const scanResult = this.loadBatch(batchId);
    if (!scanResult) {
      throw new Error(`批次不存在: ${batchId}`);
    }

    const issue = scanResult.getIssueById(issueId);
    if (!issue) {
      throw new Error(`问题不存在: ${issueId}`);
    }

    const beforeChange = JSON.parse(JSON.stringify(issue.toJSON()));
    const change = issue.setReview(status, handler, remark);

    this._pushUndo({
      type: 'ISSUE_CHANGE',
      batchId: batchId,
      issueId: issueId,
      before: beforeChange,
      change: change
    });

    this.saveBatch(scanResult);
    return { issue: issue.toJSON(), change };
  }

  batchUpdateIssues(batchId, updates, handler) {
    const scanResult = this.loadBatch(batchId);
    if (!scanResult) {
      throw new Error(`批次不存在: ${batchId}`);
    }

    const beforeStates = [];
    const changes = [];

    for (const update of updates) {
      const issue = scanResult.getIssueById(update.issueId);
      if (!issue) continue;
      if (!Object.values(REVIEW_STATUS).includes(update.status)) continue;

      beforeStates.push(JSON.parse(JSON.stringify(issue.toJSON())));
      const change = issue.setReview(update.status, handler, update.remark || '');
      changes.push({ issueId: issue.id, change });
    }

    if (beforeStates.length > 0) {
      this._pushUndo({
        type: 'BATCH_ISSUE_CHANGE',
        batchId: batchId,
        beforeStates: beforeStates,
        count: beforeStates.length
      });
    }

    this.saveBatch(scanResult);
    return changes;
  }

  canUndo() {
    return this._undoStack.length > 0;
  }

  undo() {
    if (this._undoStack.length === 0) {
      throw new EmptyUndoStackError();
    }

    const action = this._popUndo();
    const data = this._loadAllData();
    const index = this._loadIndex();

    switch (action.type) {
      case 'NEW_BATCH': {
        delete data.batches[action.batchId];
        const bp = this._getBatchPath(action.batchId);
        if (fs.existsSync(bp)) fs.unlinkSync(bp);
        index.batches = index.batches.filter(b => b.batchId !== action.batchId);
        for (const dir of Object.keys(index.directoryIndex)) {
          const entry = index.directoryIndex[dir];
          entry.batches = entry.batches.filter(bid => bid !== action.batchId);
          if (entry.batches.length === 0) {
            delete index.directoryIndex[dir];
          }
        }
        if (this.getActiveBatchId() === action.batchId) {
          if (fs.existsSync(this.activeBatchFile)) {
            fs.unlinkSync(this.activeBatchFile);
          }
        }
        break;
      }
      case 'UPDATE_BATCH': {
        data.batches[action.batchId] = action.before;
        this._saveBatchSeparate(action.batchId, new ScanResult(action.before));
        const entry = index.batches.find(b => b.batchId === action.batchId);
        if (entry) {
          const before = new ScanResult(action.before);
          entry.totalIssues = before.summary.total;
          entry.pendingIssues = before.summary.byStatus.pending;
          entry.lastModified = new Date().toISOString();
        }
        break;
      }
      case 'ISSUE_CHANGE': {
        if (data.batches[action.batchId]) {
          const issues = data.batches[action.batchId].issues;
          const idx = issues.findIndex(i => i.id === action.issueId);
          if (idx >= 0) {
            issues[idx] = action.before;
          }
          this._saveBatchSeparate(action.batchId, new ScanResult(data.batches[action.batchId]));
          const entry = index.batches.find(b => b.batchId === action.batchId);
          if (entry) {
            const sr = new ScanResult(data.batches[action.batchId]);
            entry.totalIssues = sr.summary.total;
            entry.pendingIssues = sr.summary.byStatus.pending;
            entry.lastModified = new Date().toISOString();
          }
        }
        break;
      }
      case 'BATCH_ISSUE_CHANGE':
      case 'CARRYOVER':
      case 'CLAIM':
      case 'ASSIGN': {
        if (data.batches[action.batchId]) {
          const issues = data.batches[action.batchId].issues;
          for (const before of action.beforeStates) {
            const idx = issues.findIndex(i => i.id === before.id);
            if (idx >= 0) {
              issues[idx] = before;
            }
          }
          this._saveBatchSeparate(action.batchId, new ScanResult(data.batches[action.batchId]));
          const entry = index.batches.find(b => b.batchId === action.batchId);
          if (entry) {
            const sr = new ScanResult(data.batches[action.batchId]);
            entry.totalIssues = sr.summary.total;
            entry.pendingIssues = sr.summary.byStatus.pending;
            entry.lastModified = new Date().toISOString();
          }
        }
        break;
      }
      case 'BASELINE_SAVE':
      case 'BASELINE_IMPORT': {
        const baselinesDir = path.join(this.storeDir, 'baselines');
        const baselinePath = path.join(baselinesDir, `${action.baselineName}.json`);
        if (action.previousData) {
          fs.writeFileSync(baselinePath, JSON.stringify(action.previousData, null, 2), 'utf-8');
        } else {
          if (fs.existsSync(baselinePath)) {
            fs.unlinkSync(baselinePath);
          }
        }
        break;
      }
      case 'PROFILE_ADD':
      case 'PROFILE_IMPORT': {
        const profilesDir = path.join(this.storeDir, 'profiles');
        const profilePath = path.join(profilesDir, `${action.profileName}.json`);
        if (action.previousData) {
          fs.writeFileSync(profilePath, JSON.stringify(action.previousData, null, 2), 'utf-8');
        } else {
          if (fs.existsSync(profilePath)) {
            fs.unlinkSync(profilePath);
          }
        }
        break;
      }
      case 'PROFILE_REMOVE': {
        const profilesDir = path.join(this.storeDir, 'profiles');
        const profilePath = path.join(profilesDir, `${action.profileName}.json`);
        if (action.previousData) {
          if (!fs.existsSync(profilesDir)) {
            fs.mkdirSync(profilesDir, { recursive: true });
          }
          fs.writeFileSync(profilePath, JSON.stringify(action.previousData, null, 2), 'utf-8');
        }
        break;
      }
    }

    this._saveAllData(data);
    this._saveIndex(index);
    return action;
  }

  pushBaselineUndo(action) {
    this._pushUndo(action);
  }

  pushProfileUndo(action) {
    this._pushUndo(action);
  }

  getUndoStackSize() {
    return this._undoStack.length;
  }

  _buildIssueSignature(issue) {
    const section = (issue.details && issue.details.section) || '';
    const targetPath = issue.targetPath || '';
    const message = issue.message || '';
    return `${issue.type}::${targetPath}::${section}::${message}`;
  }

  _buildIssueSignatureWithoutDesc(issue) {
    const section = (issue.details && issue.details.section) || '';
    const targetPath = issue.targetPath || '';
    return `${issue.type}::${targetPath}::${section}`;
  }

  findPreviousBatchId(currentBatchId) {
    const currentResult = this.loadBatch(currentBatchId);
    if (!currentResult || !currentResult.targetDir) return null;

    const index = this._loadIndex();
    const absDir = path.resolve(currentResult.targetDir);
    const entry = index.directoryIndex[absDir];
    if (!entry || !Array.isArray(entry.batches)) return null;

    const currentIdx = entry.batches.indexOf(currentBatchId);
    if (currentIdx <= 0) return null;

    for (let i = currentIdx - 1; i >= 0; i--) {
      const bid = entry.batches[i];
      if (this.loadBatch(bid)) return bid;
    }
    return null;
  }

  carryoverIssues(currentBatchId, previousBatchId) {
    const currentResult = this.loadBatch(currentBatchId);
    if (!currentResult) {
      throw new Error(`当前批次不存在: ${currentBatchId}`);
    }

    let prevBatchId = previousBatchId;
    if (!prevBatchId) {
      prevBatchId = this.findPreviousBatchId(currentBatchId);
    }

    if (!prevBatchId) {
      return {
        carried: 0,
        skipped: 0,
        conflicts: [],
        descChanged: [],
        warnings: ['未找到可复用的上一批次。请指定旧批次 ID 或确认同一目录存在更早的扫描。'],
        previousBatchId: null
      };
    }

    const previousResult = this.loadBatch(prevBatchId);
    if (!previousResult) {
      return {
        carried: 0,
        skipped: 0,
        conflicts: [],
        descChanged: [],
        warnings: [`旧批次 ${prevBatchId} 已被删除或数据损坏，无法复用。`],
        previousBatchId: prevBatchId
      };
    }

    const pendingIssues = currentResult.issues.filter(
      i => i.reviewStatus === REVIEW_STATUS.PENDING
    );

    if (pendingIssues.length === 0) {
      return {
        carried: 0,
        skipped: 0,
        conflicts: [],
        descChanged: [],
        warnings: ['当前批次没有待处理的问题，无需复用。'],
        previousBatchId: prevBatchId
      };
    }

    const prevReviewed = previousResult.issues.filter(
      i => i.reviewStatus !== REVIEW_STATUS.PENDING
    );

    if (prevReviewed.length === 0) {
      return {
        carried: 0,
        skipped: 0,
        conflicts: [],
        descChanged: [],
        warnings: ['上一批次中没有已处理的问题，无结果可复用。'],
        previousBatchId: prevBatchId
      };
    }

    const prevMap = new Map();
    for (const pi of prevReviewed) {
      const key = this._buildIssueSignature(pi);
      prevMap.set(key, pi);
    }

    const prevMapByWeakKey = new Map();
    for (const pi of prevReviewed) {
      const weakKey = this._buildIssueSignatureWithoutDesc(pi);
      if (!prevMapByWeakKey.has(weakKey)) {
        prevMapByWeakKey.set(weakKey, []);
      }
      prevMapByWeakKey.get(weakKey).push(pi);
    }

    const manuallyReviewedBeforeCarryover = currentResult.issues.filter(
      i => i.reviewStatus !== REVIEW_STATUS.PENDING
    );
    const manuallyReviewedSignatures = new Set(
      manuallyReviewedBeforeCarryover.map(i => this._buildIssueSignature(i))
    );

    const beforeStates = [];
    const carried = [];
    const conflicts = [];
    const descChanged = [];

    for (const currIssue of pendingIssues) {
      const strongKey = this._buildIssueSignature(currIssue);
      const prevMatch = prevMap.get(strongKey);

      if (prevMatch) {
        const beforeChange = JSON.parse(JSON.stringify(currIssue.toJSON()));
        beforeStates.push(beforeChange);

        const carryoverRemark = prevMatch.remark
          ? `${prevMatch.remark} [复用自批次 ${prevBatchId.slice(0, 16)}…]`
          : `[复用自批次 ${prevBatchId.slice(0, 16)}…]`;

        currIssue.setReview(
          prevMatch.reviewStatus,
          prevMatch.handler,
          carryoverRemark
        );
        carried.push({
          currentIssueId: currIssue.id,
          previousIssueId: prevMatch.id,
          status: prevMatch.reviewStatus,
          handler: prevMatch.handler,
          remark: prevMatch.remark,
          descChanged: false
        });
        continue;
      }

      const weakKey = this._buildIssueSignatureWithoutDesc(currIssue);
      const weakMatches = prevMapByWeakKey.get(weakKey);

      if (weakMatches && weakMatches.length > 0) {
        const weakMatch = weakMatches[0];
        descChanged.push({
          currentIssueId: currIssue.id,
          currentDesc: currIssue.message,
          previousIssueId: weakMatch.id,
          previousDesc: weakMatch.message,
          previousStatus: weakMatch.reviewStatus,
          previousHandler: weakMatch.handler
        });
        continue;
      }
    }

    let skipped = 0;
    for (const pi of prevReviewed) {
      const prevSig = this._buildIssueSignature(pi);
      if (manuallyReviewedSignatures.has(prevSig)) {
        const matchInCurrent = manuallyReviewedBeforeCarryover.find(
          ci => this._buildIssueSignature(ci) === prevSig
        );
        if (matchInCurrent) {
          skipped++;
          if (!conflicts.find(c => c.currentIssueId === matchInCurrent.id)) {
            conflicts.push({
              currentIssueId: matchInCurrent.id,
              currentStatus: matchInCurrent.reviewStatus,
              currentHandler: matchInCurrent.handler,
              previousStatus: pi.reviewStatus,
              previousHandler: pi.handler,
              reason: '当前批次已手动处理，不覆盖'
            });
          }
        }
      }
    }

    if (beforeStates.length > 0) {
      this._pushUndo({
        type: 'CARRYOVER',
        batchId: currentBatchId,
        beforeStates: beforeStates,
        previousBatchId: prevBatchId,
        count: beforeStates.length
      });
      this._persistBatchDirectly(currentResult);
    }

    return {
      carried: carried.length,
      skipped,
      conflicts,
      descChanged,
      warnings: [],
      previousBatchId: prevBatchId,
      details: carried
    };
  }

  _persistBatchDirectly(scanResult) {
    const data = this._loadAllData();
    const index = this._loadIndex();

    data.batches[scanResult.batchId] = scanResult.toJSON();
    this._saveAllData(data);
    this._saveBatchSeparate(scanResult.batchId, scanResult);

    const idx = index.batches.findIndex(b => b.batchId === scanResult.batchId);
    const entry = {
      batchId: scanResult.batchId,
      rulePath: scanResult.rulePath,
      targetDir: scanResult.targetDir,
      directorySignature: scanResult.directorySignature,
      scanTime: scanResult.scanTime,
      lastModified: new Date().toISOString(),
      totalIssues: scanResult.summary.total,
      pendingIssues: scanResult.summary.byStatus.pending
    };
    if (idx >= 0) {
      index.batches[idx] = entry;
    } else {
      index.batches.push(entry);
    }

    index.batches.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    this._saveIndex(index);
  }

  deleteBatch(batchId) {
    const data = this._loadAllData();
    const index = this._loadIndex();

    if (!data.batches[batchId]) return false;

    delete data.batches[batchId];
    index.batches = index.batches.filter(b => b.batchId !== batchId);
    for (const dir of Object.keys(index.directoryIndex)) {
      const entry = index.directoryIndex[dir];
      entry.batches = entry.batches.filter(bid => bid !== batchId);
    }
    const bp = this._getBatchPath(batchId);
    if (fs.existsSync(bp)) fs.unlinkSync(bp);
    if (this.getActiveBatchId() === batchId) {
      if (fs.existsSync(this.activeBatchFile)) {
        fs.unlinkSync(this.activeBatchFile);
      }
    }

    this._saveAllData(data);
    this._saveIndex(index);
    return true;
  }

  findIssuesByPrefix(batchId, idPrefix) {
    const scanResult = this.loadBatch(batchId);
    if (!scanResult) return { error: `批次不存在: ${batchId}`, issues: [] };
    const matches = scanResult.issues.filter(i => i.id.startsWith(idPrefix));
    if (matches.length === 0) return { error: `没有匹配问题ID前缀: ${idPrefix}`, issues: [] };
    if (matches.length > 1) return { error: `ID前缀 "${idPrefix}" 匹配到 ${matches.length} 个问题，请提供更精确的ID`, issues: [], ambiguous: true };
    return { error: null, issues: matches };
  }

  claimIssues(batchId, assignee, options = {}) {
    if (!assignee || assignee.trim() === '') {
      return { error: '负责人不能为空', claimed: 0, conflicts: [] };
    }
    const scanResult = this.loadBatch(batchId);
    if (!scanResult) return { error: `批次不存在: ${batchId}`, claimed: 0, conflicts: [] };

    let targetIssues = scanResult.issues;
    if (options.ids) {
      const idList = options.ids.split(',').map(s => s.trim());
      targetIssues = targetIssues.filter(i =>
        idList.includes(i.id) || idList.some(id => i.id.startsWith(id))
      );
    }
    if (options.type) {
      const { ISSUE_TYPE_LABELS } = require('./models');
      const typeKey = Object.keys(ISSUE_TYPE_LABELS).find(
        k => k === options.type ||
          ISSUE_TYPE_LABELS[k] === options.type ||
          k.toLowerCase() === options.type.toLowerCase()
      );
      if (typeKey) {
        targetIssues = targetIssues.filter(i => i.type === typeKey);
      }
    }
    if (options.section) {
      targetIssues = targetIssues.filter(i =>
        i.details && i.details.section && i.details.section.includes(options.section)
      );
    }

    const conflicts = [];
    const toClaim = [];
    for (const issue of targetIssues) {
      if (issue.assignee && issue.assignee !== assignee) {
        conflicts.push({
          issueId: issue.id,
          currentAssignee: issue.assignee,
          reviewStatus: issue.reviewStatus
        });
      } else if (issue.assignee === assignee) {
        conflicts.push({
          issueId: issue.id,
          samePerson: true,
          currentAssignee: issue.assignee
        });
      } else {
        toClaim.push(issue);
      }
    }

    if (toClaim.length === 0) {
      return { claimed: 0, conflicts };
    }

    const beforeStates = [];
    for (const issue of toClaim) {
      beforeStates.push(JSON.parse(JSON.stringify(issue.toJSON())));
      issue.setAssignee(assignee, assignee, '领取问题');
    }

    this._pushUndo({
      type: 'CLAIM',
      batchId: batchId,
      beforeStates: beforeStates,
      count: toClaim.length
    });

    this._persistBatchDirectly(scanResult);
    return { claimed: toClaim.length, conflicts };
  }

  assignIssues(batchId, targetAssignee, operator, options = {}) {
    if (!targetAssignee || targetAssignee.trim() === '') {
      return { error: '目标负责人不能为空', assigned: 0, conflicts: [] };
    }
    const scanResult = this.loadBatch(batchId);
    if (!scanResult) return { error: `批次不存在: ${batchId}`, assigned: 0, conflicts: [] };

    let targetIssues = scanResult.issues;
    if (options.ids) {
      const idList = options.ids.split(',').map(s => s.trim());
      targetIssues = targetIssues.filter(i =>
        idList.includes(i.id) || idList.some(id => i.id.startsWith(id))
      );
    }
    if (options.type) {
      const { ISSUE_TYPE_LABELS } = require('./models');
      const typeKey = Object.keys(ISSUE_TYPE_LABELS).find(
        k => k === options.type ||
          ISSUE_TYPE_LABELS[k] === options.type ||
          k.toLowerCase() === options.type.toLowerCase()
      );
      if (typeKey) {
        targetIssues = targetIssues.filter(i => i.type === typeKey);
      }
    }
    if (options.section) {
      targetIssues = targetIssues.filter(i =>
        i.details && i.details.section && i.details.section.includes(options.section)
      );
    }

    const conflicts = [];
    const toAssign = [];
    const force = options.force || false;
    const reason = options.reason || '';

    for (const issue of targetIssues) {
      if (issue.assignee === targetAssignee) {
        conflicts.push({
          issueId: issue.id,
          samePerson: true,
          currentAssignee: issue.assignee
        });
        continue;
      }
      if (issue.reviewStatus === REVIEW_STATUS.CONFIRMED || issue.reviewStatus === REVIEW_STATUS.IGNORED) {
        if (!force) {
          conflicts.push({
            issueId: issue.id,
            alreadyFinalized: true,
            reviewStatus: issue.reviewStatus,
            currentAssignee: issue.assignee
          });
          continue;
        }
      }
      if (issue.assignee && issue.assignee !== targetAssignee && !force) {
        conflicts.push({
          issueId: issue.id,
          alreadyClaimed: true,
          currentAssignee: issue.assignee,
          reviewStatus: issue.reviewStatus
        });
        continue;
      }
      toAssign.push(issue);
    }

    if (toAssign.length === 0) {
      return { assigned: 0, conflicts };
    }

    const beforeStates = [];
    for (const issue of toAssign) {
      beforeStates.push(JSON.parse(JSON.stringify(issue.toJSON())));
      const assignReason = reason || `转派给 ${targetAssignee}`;
      issue.setAssignee(targetAssignee, operator, assignReason);
    }

    this._pushUndo({
      type: 'ASSIGN',
      batchId: batchId,
      beforeStates: beforeStates,
      count: toAssign.length
    });

    this._persistBatchDirectly(scanResult);
    return { assigned: toAssign.length, conflicts };
  }
}

module.exports = {
  StateStore,
  EmptyUndoStackError
};
