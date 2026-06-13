const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

class ProfileError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
  }
}

class ProfileManager {
  constructor(storeDir) {
    this.storeDir = storeDir || path.join(process.cwd(), '.bbcheck');
    this.profilesDir = path.join(this.storeDir, 'profiles');
    this.supportedExtensions = ['.yaml', '.yml', '.json'];
    this._ensureProfilesDir();
  }

  _ensureProfilesDir() {
    if (!fs.existsSync(this.profilesDir)) {
      try {
        fs.mkdirSync(this.profilesDir, { recursive: true });
      } catch (e) {
        throw new ProfileError(
          `无法创建 profile 存储目录: ${this.profilesDir} — ${e.message}`,
          'STORAGE_NOT_WRITABLE'
        );
      }
    }
    try {
      fs.accessSync(this.profilesDir, fs.constants.W_OK);
    } catch (e) {
      throw new ProfileError(
        `profile 存储目录不可写: ${this.profilesDir}`,
        'STORAGE_NOT_WRITABLE'
      );
    }
  }

  _validateName(name) {
    if (!name || typeof name !== 'string' || name.trim() === '') {
      throw new ProfileError('profile 名称不能为空', 'EMPTY_NAME');
    }
    if (!/^[a-zA-Z0-9_\-.]+$/.test(name)) {
      throw new ProfileError(
        `profile 名称 "${name}" 包含非法字符，仅允许字母、数字、下划线、连字符、点`,
        'INVALID_NAME'
      );
    }
  }

  _profilePath(name) {
    return path.join(this.profilesDir, `${name}.json`);
  }

  _loadRuleFile(rulePath) {
    const absPath = path.resolve(rulePath);
    if (!fs.existsSync(absPath)) {
      throw new ProfileError(`规则文件不存在: ${absPath}`, 'RULE_NOT_FOUND');
    }
    const ext = path.extname(absPath).toLowerCase();
    if (!this.supportedExtensions.includes(ext)) {
      throw new ProfileError(
        `不支持的规则文件格式: ${ext}，请使用 .yaml, .yml 或 .json`,
        'INVALID_RULE_FORMAT'
      );
    }
    let raw;
    try {
      raw = fs.readFileSync(absPath, 'utf-8');
    } catch (e) {
      throw new ProfileError(`读取规则文件失败: ${e.message}`, 'RULE_READ_ERROR');
    }
    let parsed;
    try {
      if (ext === '.json') {
        parsed = JSON.parse(raw);
      } else {
        parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
      }
    } catch (e) {
      const marker = e.mark ? ` (行 ${e.mark.line + 1}, 列 ${e.mark.column + 1})` : '';
      throw new ProfileError(
        `规则文件解析失败${marker}: ${e.message}`,
        'RULE_PARSE_ERROR'
      );
    }
    return {
      originalPath: absPath,
      format: ext.slice(1),
      rawContent: raw,
      parsed: parsed
    };
  }

  add(name, rulePath, options = {}) {
    this._validateName(name);
    const loaded = this._loadRuleFile(rulePath);
    const targetPath = this._profilePath(name);
    let overwritten = false;
    let previousData = null;
    if (fs.existsSync(targetPath)) {
      if (!options.force) {
        throw new ProfileError(
          `同名 profile "${name}" 已存在，使用 --force 覆盖`,
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
    const profileData = {
      name: name,
      createdAt: new Date().toISOString(),
      lastUsedDir: null,
      lastUsedAt: null,
      originalRulePath: loaded.originalPath,
      ruleFormat: loaded.format,
      ruleContent: loaded.rawContent,
      ruleData: loaded.parsed
    };
    try {
      const tmpFile = targetPath + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(profileData, null, 2), 'utf-8');
      fs.renameSync(tmpFile, targetPath);
    } catch (e) {
      throw new ProfileError(
        `写入 profile 文件失败: ${e.message}`,
        'STORAGE_NOT_WRITABLE'
      );
    }
    return {
      name,
      overwritten,
      previousData,
      ruleFormat: loaded.format,
      ruleName: (loaded.parsed && loaded.parsed.name) || '未命名规则',
      sectionCount: (loaded.parsed && loaded.parsed.sections && loaded.parsed.sections.length) || 0
    };
  }

  list() {
    if (!fs.existsSync(this.profilesDir)) {
      return [];
    }
    const entries = [];
    try {
      const files = fs.readdirSync(this.profilesDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const filePath = path.join(this.profilesDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          entries.push({
            name: data.name || path.basename(file, '.json'),
            createdAt: data.createdAt || null,
            lastUsedDir: data.lastUsedDir || null,
            lastUsedAt: data.lastUsedAt || null,
            ruleFormat: data.ruleFormat || null,
            ruleName: (data.ruleData && data.ruleData.name) || '-',
            sectionCount: (data.ruleData && data.ruleData.sections && data.ruleData.sections.length) || 0,
            corrupted: false
          });
        } catch (_) {
          entries.push({
            name: path.basename(file, '.json'),
            corrupted: true
          });
        }
      }
    } catch (e) {
        throw new ProfileError(
          `读取 profile 目录失败: ${e.message}`,
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

  show(name) {
    this._validateName(name);
    const filePath = this._profilePath(name);
    if (!fs.existsSync(filePath)) {
      throw new ProfileError(
        `profile "${name}" 不存在`,
        'NOT_FOUND'
      );
    }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      throw new ProfileError(
        `profile 文件 "${name}" 已损坏: ${e.message}`,
        'CORRUPTED'
      );
    }
    const ruleData = data.ruleData || {};
    const sections = (ruleData.sections || []).map(s => ({
      name: s.name || '',
      order: s.order || null,
      directory: s.directory || null,
      requiredFiles: (s.requiredFiles || []).length,
      namingPatterns: (s.namingPatterns || []).length
    }));
    let previewLines = [];
    if (data.ruleContent) {
      const lines = data.ruleContent.split(/\r?\n/);
      previewLines = lines.slice(0, 20);
    }
    return {
      name: data.name,
      createdAt: data.createdAt,
      lastUsedDir: data.lastUsedDir,
      lastUsedAt: data.lastUsedAt,
      originalRulePath: data.originalRulePath,
      ruleFormat: data.ruleFormat,
      ruleName: ruleData.name || '-',
      ruleVersion: ruleData.version || '-',
      ruleDescription: ruleData.description || '',
      globalSignatureRequired: !!ruleData.globalSignatureRequired,
      sectionCount: sections.length,
      sections,
      previewLines,
      raw: data
    };
  }

  remove(name, options = {}) {
    this._validateName(name);
    const filePath = this._profilePath(name);
    if (!fs.existsSync(filePath)) {
      throw new ProfileError(
        `profile "${name}" 不存在`,
        'NOT_FOUND'
      );
    }
    let previousData = null;
    try {
      previousData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (_) {
      previousData = null;
    }
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      throw new ProfileError(
        `删除 profile 文件失败: ${e.message}`,
        'STORAGE_NOT_WRITABLE'
      );
    }
    return {
      name,
      previousData
    };
  }

  load(name) {
    this._validateName(name);
    const filePath = this._profilePath(name);
    if (!fs.existsSync(filePath)) {
      throw new ProfileError(
      `profile "${name}" 不存在`,
        'NOT_FOUND'
      );
    }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      throw new ProfileError(
        `profile 文件 "${name}" 已损坏: ${e.message}`,
        'CORRUPTED'
      );
    }
    if (!data.ruleData || !Array.isArray(data.ruleData.sections)) {
      throw new ProfileError(
        `profile "${name}" 缺少规则数据 (已损坏或不完整)`,
        'CORRUPTED'
      );
    }
    const rule = Object.assign({}, data.ruleData, {
      _sourcePath: `profile://${name} (${data.originalRulePath || 'profile'})`
    });
    return {
      rule,
      profileName: name,
      originalRulePath: data.originalRulePath
    };
  }

  markUsed(name, targetDir) {
    this._validateName(name);
    const filePath = this._profilePath(name);
    if (!fs.existsSync(filePath)) {
      throw new ProfileError(
        `profile "${name}" 不存在`,
        'NOT_FOUND'
      );
    }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      throw new ProfileError(
        `profile 文件 "${name}" 已损坏: ${e.message}`,
        'CORRUPTED'
      );
    }
    data.lastUsedDir = path.resolve(targetDir);
    data.lastUsedAt = new Date().toISOString();
    try {
      const tmpFile = filePath + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpFile, filePath);
    } catch (e) {
      throw new ProfileError(
        `更新 profile 文件失败: ${e.message}`,
        'STORAGE_NOT_WRITABLE'
      );
    }
    return true;
  }

  restore(name, profileData) {
    if (!profileData || typeof profileData !== 'object') {
      throw new ProfileError('恢复 profile 需要有效的数据', 'INVALID_DATA');
    }
    this._validateName(name);
    const filePath = this._profilePath(name);
    let overwritten = false;
    let previousData = null;
    if (fs.existsSync(filePath)) {
      overwritten = true;
      try {
        previousData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch (_) {
        previousData = null;
      }
    }
    try {
      const tmpFile = filePath + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(profileData, null, 2), 'utf-8');
      fs.renameSync(tmpFile, filePath);
    } catch (e) {
      throw new ProfileError(
        `恢复 profile 文件失败: ${e.message}`,
        'STORAGE_NOT_WRITABLE'
      );
    }
    return { name, overwritten, previousData };
  }

  exportProfile(name, outputPath) {
    this._validateName(name);
    const filePath = this._profilePath(name);
    if (!fs.existsSync(filePath)) {
      throw new ProfileError(
        `profile "${name}" 不存在`,
        'NOT_FOUND'
      );
    }
    let profileData;
    try {
      profileData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      throw new ProfileError(
        `profile 文件 "${name}" 已损坏: ${e.message}`,
        'CORRUPTED'
      );
    }
    const absOutput = path.resolve(outputPath);
    const outputDir = path.dirname(absOutput);
    if (!fs.existsSync(outputDir)) {
      try {
        fs.mkdirSync(outputDir, { recursive: true });
      } catch (e) {
        throw new ProfileError(
          `无法创建输出目录: ${outputDir} — ${e.message}`,
          'STORAGE_NOT_WRITABLE'
        );
      }
    }
    const exportData = {
      _meta: {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        type: 'bbcheck-profile'
      },
      profile: profileData
    };
    try {
      const tmpFile = absOutput + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(exportData, null, 2), 'utf-8');
      fs.renameSync(tmpFile, absOutput);
    } catch (e) {
      throw new ProfileError(
        `写入导出文件失败: ${e.message}`,
        'STORAGE_NOT_WRITABLE'
      );
    }
    return {
      name,
      outputPath: absOutput,
      sectionCount: (profileData.ruleData && profileData.ruleData.sections && profileData.ruleData.sections.length) || 0
    };
  }

  importProfile(filePath, options = {}) {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
      throw new ProfileError(
        `导入文件不存在: ${absPath}`,
        'FILE_NOT_FOUND'
      );
    }
    let importData;
    try {
      const raw = fs.readFileSync(absPath, 'utf-8');
      importData = JSON.parse(raw);
    } catch (e) {
      throw new ProfileError(
        `导入文件已损坏或不是有效的 JSON: ${e.message}`,
        'CORRUPTED'
      );
    }
    let profileData;
    if (importData._meta && importData._meta.type === 'bbcheck-profile') {
      profileData = importData.profile;
    } else if (importData.name && importData.ruleData) {
      profileData = importData;
    } else {
      throw new ProfileError(
        '导入文件不是有效的 bbcheck profile 文件（缺少 _meta.type 标识或必要字段）',
        'CORRUPTED'
      );
    }
    if (!profileData || !profileData.name || !profileData.ruleData || !Array.isArray(profileData.ruleData.sections)) {
      throw new ProfileError(
        '导入的 profile 数据缺少必要字段 (name, ruleData.sections)',
        'CORRUPTED'
      );
    }
    const targetName = options.name || profileData.name;
    this._validateName(targetName);
    if (options.name) {
      profileData = JSON.parse(JSON.stringify(profileData));
      profileData.originalName = profileData.name;
      profileData.name = targetName;
    }
    profileData.importedFrom = absPath;
    profileData.importedAt = new Date().toISOString();
    const targetPath = this._profilePath(targetName);
    let overwritten = false;
    let previousData = null;
    if (fs.existsSync(targetPath)) {
      if (!options.force) {
        throw new ProfileError(
          `同名 profile "${targetName}" 已存在，使用 --force 覆盖`,
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
    try {
      const tmpFile = targetPath + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(profileData, null, 2), 'utf-8');
      fs.renameSync(tmpFile, targetPath);
    } catch (e) {
      throw new ProfileError(
        `写入 profile 文件失败: ${e.message}`,
        'STORAGE_NOT_WRITABLE'
      );
    }
    return {
      name: targetName,
      overwritten,
      previousData,
      sectionCount: profileData.ruleData.sections.length
    };
  }
}

module.exports = {
  ProfileManager,
  ProfileError
};
