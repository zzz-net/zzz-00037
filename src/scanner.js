const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ISSUE_TYPES, ScanResult } = require('./models');

class DirectoryNotFoundError extends Error {
  constructor(dir) {
    super(`资料目录不存在: ${dir}`);
    this.name = 'DirectoryNotFoundError';
    this.dir = dir;
  }
}

class Scanner {
  constructor() {
    this.supportedExtensions = [
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff',
      '.txt', '.md', '.rtf', '.zip', '.rar', '.7z'
    ];
  }

  scan(targetDir, rule) {
    const absDir = path.resolve(targetDir);
    if (!fs.existsSync(absDir)) {
      throw new DirectoryNotFoundError(absDir);
    }
    if (!fs.statSync(absDir).isDirectory()) {
      throw new DirectoryNotFoundError(`${absDir} 不是目录`);
    }

    const result = new ScanResult({
      rulePath: rule._sourcePath,
      targetDir: absDir
    });

    const allFiles = this.walkDirectory(absDir);
    result.scannedFiles = allFiles.map(f => path.relative(absDir, f));
    result.directorySignature = this.computeSignature(absDir, allFiles);

    this.checkDirectoryOrder(result, rule, absDir);

    const trackedFiles = new Set();

    for (const section of rule.sections) {
      this.checkSection(
        result,
        rule,
        section,
        absDir,
        trackedFiles
      );
    }

    this.checkUntrackedFiles(result, absDir, allFiles, trackedFiles, rule);

    result.recalculateSummary();
    return result;
  }

  walkDirectory(dir, baseDir = dir, results = []) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          this.walkDirectory(fullPath, baseDir, results);
        } else if (entry.isFile()) {
          results.push(fullPath);
        }
      }
    } catch (e) {
    }
    return results;
  }

  computeSignature(rootDir, files) {
    const hasher = crypto.createHash('sha256');
    hasher.update(rootDir);
    for (const file of files) {
      try {
        const stat = fs.statSync(file);
        hasher.update(path.relative(rootDir, file));
        hasher.update('|');
        hasher.update(stat.size.toString());
        hasher.update('|');
        hasher.update(stat.mtimeMs.toString());
        hasher.update('\n');
      } catch (e) {
      }
    }
    return hasher.digest('hex');
  }

  checkDirectoryOrder(result, rule, absDir) {
    const sortedByOrder = [...rule.sections].sort((a, b) => a.order - b.order);
    const originalOrder = rule.sections.map(s => s.name);
    const sortedOrder = sortedByOrder.map(s => s.name);

    if (originalOrder.join(',') !== sortedOrder.join(',')) {
      let expectedCorrect = true;
      const actualDirs = [];
      try {
        const entries = fs.readdirSync(absDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) {
            actualDirs.push(e.name);
          }
        }
      } catch (e) {
      }

      const ruleSectionDirs = rule.sections
        .filter(s => s.directory)
        .map(s => ({ name: s.name, dir: s.directory, order: s.order }));

      if (ruleSectionDirs.length > 0) {
        for (let i = 0; i < ruleSectionDirs.length - 1; i++) {
          const a = ruleSectionDirs[i];
          const b = ruleSectionDirs[i + 1];
          const aIdx = actualDirs.indexOf(a.dir);
          const bIdx = actualDirs.indexOf(b.dir);
          if (aIdx >= 0 && bIdx >= 0 && aIdx > bIdx) {
            expectedCorrect = false;
            result.addIssue({
              type: ISSUE_TYPES.ORDER_ERROR,
              severity: 'warn',
              message: `目录顺序异常: ${a.dir} (章节"${a.name}", 顺序号${a.order}) 应在 ${b.dir} (章节"${b.name}", 顺序号${b.order}) 之前`,
              targetPath: absDir,
              expected: `${a.dir} 在 ${b.dir} 之前`,
              actual: `${b.dir} 在 ${a.dir} 之前`,
              details: {
                sectionA: a,
                sectionB: b,
                actualIndexA: aIdx,
                actualIndexB: bIdx
              }
            });
            break;
          }
        }
      }
    }
  }

  checkSection(result, rule, section, absDir, trackedFiles) {
    const sectionDir = section.directory
      ? path.join(absDir, section.directory)
      : absDir;

    const sectionRelativeDir = section.directory || '.';

    const sectionFiles = [];
    if (fs.existsSync(sectionDir) && fs.statSync(sectionDir).isDirectory()) {
      try {
        const entries = fs.readdirSync(sectionDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isFile()) {
            sectionFiles.push({
              name: e.name,
              fullPath: path.join(sectionDir, e.name),
              relPath: path.join(sectionRelativeDir, e.name)
            });
          }
        }
      } catch (e) {
      }
    }

    this.checkRequiredFiles(result, section, sectionDir, sectionRelativeDir, sectionFiles, trackedFiles, rule);
    this.checkNamingPatterns(result, section, sectionRelativeDir, sectionFiles, trackedFiles, rule);
    this.checkPageRange(result, section, sectionRelativeDir, sectionFiles, rule);
    this.checkExpiryFields(result, section, sectionRelativeDir, sectionFiles, rule);
    this.checkSignatures(result, section, sectionRelativeDir, sectionFiles, rule);
  }

  checkRequiredFiles(result, section, sectionDir, sectionRelativeDir, sectionFiles, trackedFiles, rule) {
    for (const reqFile of section.requiredFiles) {
      const targetRelPath = path.join(sectionRelativeDir, reqFile.path);
      const targetFullPath = path.join(sectionDir, reqFile.path);
      const exists = fs.existsSync(targetFullPath);

      trackedFiles.add(path.resolve(targetFullPath));

      if (!exists) {
        if (!reqFile.optional) {
          result.addIssue({
            type: ISSUE_TYPES.MISSING_FILE,
            severity: 'error',
            message: `章节[${section.name}] 缺少必需文件: ${targetRelPath}`,
            targetPath: targetRelPath,
            expected: reqFile.path,
            actual: null,
            details: {
              section: section.name,
              file: reqFile.path,
              description: reqFile.description
            }
          });
        }
        continue;
      }

      const sigRequired = reqFile.signatureRequired !== null
        ? reqFile.signatureRequired
        : (section.signatureRequired || rule.globalSignatureRequired);
      if (sigRequired) {
        this.checkSingleFileSignature(result, section, sectionRelativeDir, reqFile.path, targetFullPath, rule);
      }

      if (reqFile.pageRange) {
        this.checkSingleFilePageRange(result, section, sectionRelativeDir, reqFile.path, reqFile.pageRange);
      }
    }
  }

  checkNamingPatterns(result, section, sectionRelativeDir, sectionFiles, trackedFiles, rule) {
    if (section.namingPatterns.length === 0 && !rule.globalNamingPattern) {
      return;
    }

    let patterns = section.namingPatterns || [];
    if (patterns.length === 0 && rule.globalNamingPattern) {
      try {
        patterns = [{
          pattern: rule.globalNamingPattern,
          label: rule.globalNamingPattern,
          regex: new RegExp(rule.globalNamingPattern),
          extractVersion: false
        }];
      } catch (e) {
        patterns = [];
      }
    }

    patterns = patterns.map(p => {
      if (!p.regex) {
        try { p.regex = new RegExp(p.pattern || '.*'); }
        catch (_) { p.regex = /.*$/; }
      }
      if (!p.label) p.label = p.pattern || '';
      return p;
    });

    const versionedFiles = {};

    for (const file of sectionFiles) {
      const matchesAny = patterns.length === 0
        ? false
        : patterns.some(p => p.regex && p.regex.test(file.name));

      if (!matchesAny) {
        const matchedByRequired = section.requiredFiles.some(rf => {
          const rfFull = path.resolve(path.join(section.directory || '.', rf.path));
          const fileFull = path.resolve(file.fullPath);
          return rfFull === fileFull || file.name === rf.path;
        });
        if (!matchedByRequired) {
          result.addIssue({
            type: ISSUE_TYPES.NAMING_ERROR,
            severity: 'warn',
            message: `章节[${section.name}] 文件命名不符合规则: ${file.relPath}`,
            targetPath: file.relPath,
            expected: patterns.map(p => p.label).join(' 或 '),
            actual: file.name,
            details: {
              section: section.name,
              patterns: patterns.map(p => p.label)
            }
          });
        }
      } else {
        for (const p of patterns) {
          if (p.extractVersion && p.regex.test(file.name)) {
            const m = file.name.match(p.regex);
            if (m && m[p.versionGroup] !== undefined) {
              const version = m[p.versionGroup];
              const baseKey = file.name.replace(p.regex, (match, ...groups) => {
                return match.replace(groups[p.versionGroup - 1] || '', 'VERSION');
              });
              if (!versionedFiles[baseKey]) {
                versionedFiles[baseKey] = [];
              }
              versionedFiles[baseKey].push({
                file: file,
                version: version
              });
            }
          }
        }
      }
    }

    for (const baseKey of Object.keys(versionedFiles)) {
      const group = versionedFiles[baseKey];
      if (group.length > 1) {
        const versions = group.map(g => `${g.file.relPath}(版本:${g.version})`).join(', ');
        result.addIssue({
          type: ISSUE_TYPES.DUPLICATE_VERSION,
          severity: 'error',
          message: `章节[${section.name}] 检测到重复版本文件: ${versions}`,
          targetPath: group[0].file.relPath,
          expected: '仅保留一个版本',
          actual: `存在 ${group.length} 个版本`,
          details: {
            section: section.name,
            files: group.map(g => ({
              path: g.file.relPath,
              version: g.version
            }))
          }
        });
      }
    }
  }

  checkPageRange(result, section, sectionRelativeDir, sectionFiles, rule) {
    const pageRange = section.pageRange || rule.globalPageRange;
    if (!pageRange) return;

    const pageNumbers = [];
    const pageMap = {};
    const pageRegex = /(\d+)/;

    for (const file of sectionFiles) {
      const stem = path.basename(file.name, path.extname(file.name));
      const m = stem.match(pageRegex);
      if (m) {
        const pageNum = parseInt(m[1]);
        pageNumbers.push(pageNum);
        if (!pageMap[pageNum]) {
          pageMap[pageNum] = [];
        }
        pageMap[pageNum].push(file.relPath);
      }
    }

    if (pageNumbers.length === 0) return;

    pageNumbers.sort((a, b) => a - b);
    const min = pageNumbers[0];
    const max = pageNumbers[pageNumbers.length - 1];

    if (min < pageRange.start || max > pageRange.end) {
      result.addIssue({
        type: ISSUE_TYPES.PAGE_DISCONTINUITY,
        severity: 'warn',
        message: `章节[${section.name}] 页码超出范围: 实际页码 ${min}-${max}, 期望 ${pageRange.start}-${pageRange.end}`,
        targetPath: sectionRelativeDir,
        expected: `${pageRange.start}-${pageRange.end}`,
        actual: `${min}-${max}`,
        details: {
          section: section.name,
          expectedRange: pageRange,
          actualRange: { start: min, end: max }
        }
      });
    }

    for (let i = pageRange.start; i <= pageRange.end; i++) {
      if (!pageMap[i]) {
        result.addIssue({
          type: ISSUE_TYPES.PAGE_DISCONTINUITY,
          severity: 'error',
          message: `章节[${section.name}] 页码不连续: 缺失第 ${i} 页`,
          targetPath: sectionRelativeDir,
          expected: `存在第 ${i} 页的文件`,
          actual: `未找到第 ${i} 页`,
          details: {
            section: section.name,
            missingPage: i,
            range: pageRange
          }
        });
      } else if (pageMap[i].length > 1) {
        result.addIssue({
          type: ISSUE_TYPES.PAGE_DISCONTINUITY,
          severity: 'warn',
          message: `章节[${section.name}] 页码重复: 第 ${i} 页存在多个文件 (${pageMap[i].join(', ')})`,
          targetPath: sectionRelativeDir,
          expected: `仅一个文件映射到第 ${i} 页`,
          actual: `${pageMap[i].length} 个文件`,
          details: {
            section: section.name,
            duplicatePage: i,
            files: pageMap[i]
          }
        });
      }
    }
  }

  checkExpiryFields(result, section, sectionRelativeDir, sectionFiles, rule) {
    const expiryField = section.expiryField || rule.globalExpiryField;
    if (!expiryField || !expiryField.fieldName) return;

    const today = new Date();
    const dateRegexes = [
      /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})[日号]?/,
      /(\d{4})(\d{2})(\d{2})/
    ];

    for (const file of sectionFiles) {
      const name = file.name;
      for (const regex of dateRegexes) {
        const m = name.match(regex);
        if (m) {
          const year = parseInt(m[1]);
          const month = parseInt(m[2]) - 1;
          const day = parseInt(m[3]);
          const expiryDate = new Date(year, month, day);

          if (!isNaN(expiryDate.getTime()) && expiryDate < today) {
            result.addIssue({
              type: ISSUE_TYPES.EXPIRED_FIELD,
              severity: 'warn',
              message: `章节[${section.name}] 检测到过期日期: ${file.relPath} (到期日: ${year}-${m[2]}-${m[3]})`,
              targetPath: file.relPath,
              expected: `日期 >= ${today.toISOString().slice(0, 10)}`,
              actual: `${year}-${m[2]}-${m[3]}`,
              details: {
                section: section.name,
                expiryDate: expiryDate.toISOString().slice(0, 10),
                fieldName: expiryField.fieldName
              }
            });
            break;
          }
        }
      }
    }
  }

  checkSignatures(result, section, sectionRelativeDir, sectionFiles, rule) {
    if (!section.signatureRequired && !rule.globalSignatureRequired) return;

    const sigKeywords = ['签章', '盖章', '签名', '签字', '已签', 'signed', 'signed_', '_signed'];
    const sigIndicatorRegex = /(_signed|签章|盖章|签名|签字)$/i;

    for (const file of sectionFiles) {
      const stem = path.basename(file.name, path.extname(file.name));
      const hasSigIndicator = sigIndicatorRegex.test(stem);

      let hasSigInName = false;
      for (const kw of sigKeywords) {
        if (file.name.toLowerCase().includes(kw.toLowerCase())) {
          hasSigInName = true;
          break;
        }
      }

      const sizeOk = fs.existsSync(file.fullPath) && fs.statSync(file.fullPath).size > 1024;

      if (!hasSigIndicator && !hasSigInName) {
        result.addIssue({
          type: ISSUE_TYPES.MISSING_SIGNATURE,
          severity: 'warn',
          message: `章节[${section.name}] 可能缺少签章: ${file.relPath} (文件名未包含签章标识)`,
          targetPath: file.relPath,
          expected: '文件名包含"签章/盖章/签名/签字/_signed"等标识',
          actual: file.name,
          details: {
            section: section.name,
            file: file.relPath,
            sizeCheck: sizeOk
          }
        });
      }
    }
  }

  checkSingleFileSignature(result, section, sectionRelativeDir, reqFilePath, fullPath, rule) {
    const file = path.basename(reqFilePath);
    const stem = path.basename(file, path.extname(file));
    const sigKeywords = ['签章', '盖章', '签名', '签字', '已签', 'signed'];
    let hasSig = false;
    for (const kw of sigKeywords) {
      if (file.toLowerCase().includes(kw.toLowerCase())) {
        hasSig = true;
        break;
      }
    }
    const sigIndicatorRegex = /(_signed|签章|盖章|签名|签字)$/i;
    if (!sigIndicatorRegex.test(stem) && !hasSig) {
      result.addIssue({
        type: ISSUE_TYPES.MISSING_SIGNATURE,
        severity: 'error',
        message: `章节[${section.name}] 指定文件缺少签章标识: ${path.join(sectionRelativeDir, reqFilePath)}`,
        targetPath: path.join(sectionRelativeDir, reqFilePath),
        expected: '文件名包含签章标识',
        actual: file,
        details: { section: section.name }
      });
    }
  }

  checkSingleFilePageRange(result, section, sectionRelativeDir, reqFilePath, pageRange) {
    const file = path.basename(reqFilePath);
    const stem = path.basename(file, path.extname(file));
    const m = stem.match(/(\d+)/);
    if (m && pageRange) {
      const pageNum = parseInt(m[1]);
      const range = typeof pageRange === 'string'
        ? (() => {
            const mm = pageRange.match(/^(\d+)\s*[-~]\s*(\d+)$/);
            return mm ? { start: parseInt(mm[1]), end: parseInt(mm[2]) } : null;
          })()
        : pageRange;

      if (range && (pageNum < range.start || pageNum > range.end)) {
        result.addIssue({
          type: ISSUE_TYPES.PAGE_DISCONTINUITY,
          severity: 'warn',
          message: `章节[${section.name}] 文件页码超出范围: ${path.join(sectionRelativeDir, reqFilePath)}`,
          targetPath: path.join(sectionRelativeDir, reqFilePath),
          expected: `页码在 ${range.start}-${range.end} 内`,
          actual: pageNum,
          details: { section: section.name }
        });
      }
    }
  }

  checkUntrackedFiles(result, absDir, allFiles, trackedFiles, rule) {
    for (const file of allFiles) {
      const resolved = path.resolve(file);
      if (trackedFiles.has(resolved)) continue;

      const relPath = path.relative(absDir, file);
      const parts = relPath.split(path.sep);

      let matchedSection = null;
      if (parts.length > 1) {
        matchedSection = rule.sections.find(s => s.directory === parts[0]);
      }

      if (matchedSection && matchedSection.allowUntracked) {
        continue;
      }

      result.addIssue({
        type: ISSUE_TYPES.UNTRACKED_FILE,
        severity: 'info',
        message: matchedSection
          ? `章节[${matchedSection.name}] 存在未纳入规则的文件: ${relPath}`
          : `未纳入规则的文件: ${relPath}`,
        targetPath: relPath,
        expected: '在规则中定义该文件的用途',
        actual: relPath,
        details: {
          section: matchedSection ? matchedSection.name : null
        }
      });
    }
  }
}

module.exports = {
  Scanner,
  DirectoryNotFoundError
};
