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
    if (!entry) return { exists: false };
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
    fs.writeFileSync(this.activeBatchFile, batchId, 'utf-8');
  }

  getActiveBatchId() {
    if (!fs.existsSync(this.activeBatchFile)) return null;
    return fs.readFileSync(this.activeBatchFile, 'utf-8').trim();
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
        }
        if (this.getActiveBatchId() === action.batchId) {
          fs.unlinkSync(this.activeBatchFile);
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
      case 'BATCH_ISSUE_CHANGE': {
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
    }

    this._saveAllData(data);
    this._saveIndex(index);
    return action;
  }

  getUndoStackSize() {
    return this._undoStack.length;
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
}

module.exports = {
  StateStore,
  EmptyUndoStackError
};
