const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

class RuleValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'RuleValidationError';
    this.field = field;
  }
}

class RuleParser {
  constructor() {
    this.supportedExtensions = ['.yaml', '.yml', '.json'];
  }

  load(rulePath) {
    const absPath = path.resolve(rulePath);

    if (!fs.existsSync(absPath)) {
      throw new RuleValidationError(`规则文件不存在: ${absPath}`, 'file');
    }

    const ext = path.extname(absPath).toLowerCase();
    if (!this.supportedExtensions.includes(ext)) {
      throw new RuleValidationError(
        `不支持的规则文件格式: ${ext}，请使用 .yaml, .yml 或 .json`,
        'format'
      );
    }

    let rawData;
    try {
      rawData = fs.readFileSync(absPath, 'utf-8');
    } catch (e) {
      throw new RuleValidationError(`读取规则文件失败: ${e.message}`, 'file');
    }

    let parsed;
    try {
      if (ext === '.json') {
        parsed = JSON.parse(rawData);
      } else {
        parsed = yaml.load(rawData, { schema: yaml.JSON_SCHEMA });
      }
    } catch (e) {
      const marker = e.mark ? ` (行 ${e.mark.line + 1}, 列 ${e.mark.column + 1})` : '';
      throw new RuleValidationError(
        `规则文件解析失败${marker}: ${e.message}`,
        'parse'
      );
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new RuleValidationError('规则文件必须是一个对象', 'root');
    }

    return this.validate(parsed, absPath);
  }

  loadForPreview(rulePath) {
    const absPath = path.resolve(rulePath);
    const errors = [];
    const warnings = [];
    let rule = null;
    const info = { path: absPath, format: null, size: null };

    if (!fs.existsSync(absPath)) {
      errors.push(`规则文件不存在: ${absPath}`);
      return { rule, errors, warnings, info };
    }

    const ext = path.extname(absPath).toLowerCase();
    if (!this.supportedExtensions.includes(ext)) {
      errors.push(`不支持的规则文件格式: ${ext}，请使用 .yaml, .yml 或 .json`);
      return { rule, errors, warnings, info };
    }
    info.format = ext.slice(1);

    try {
      const stat = fs.statSync(absPath);
      info.size = stat.size;
    } catch (_) {}

    let rawData;
    try {
      rawData = fs.readFileSync(absPath, 'utf-8');
    } catch (e) {
      errors.push(`读取规则文件失败: ${e.message}`);
      return { rule, errors, warnings, info };
    }

    let parsed;
    try {
      if (ext === '.json') {
        parsed = JSON.parse(rawData);
      } else {
        parsed = yaml.load(rawData, { schema: yaml.JSON_SCHEMA });
      }
    } catch (e) {
      const marker = e.mark ? ` (行 ${e.mark.line + 1}, 列 ${e.mark.column + 1})` : '';
      errors.push(`规则文件解析失败${marker}: ${e.message}`);
      return { rule, errors, warnings, info };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push('规则文件必须是一个对象');
      return { rule, errors, warnings, info };
    }

    const result = this.validateForPreview(parsed, absPath);
    rule = result.rule;
    for (const e of result.errors) errors.push(e);
    for (const w of result.warnings) warnings.push(w);
    return { rule, errors, warnings, info };
  }

  validate(data, sourcePath) {
    const result = this.validateForPreview(data, sourcePath);
    if (result.errors.length > 0) {
      throw new RuleValidationError(
        '规则校验失败:\n  - ' + result.errors.join('\n  - '),
        'validation'
      );
    }
    return result.rule;
  }

  validateForPreview(data, sourcePath) {
    const errors = [];
    const warnings = [];

    if (!data.name) {
      errors.push('缺少必填字段: name (规则名称)');
    }
    if (typeof data.name !== 'undefined' && typeof data.name !== 'string') {
      errors.push('字段 name 必须是字符串');
    }

    if (!data.sections) {
      errors.push('缺少必填字段: sections (章节列表)');
    } else if (!Array.isArray(data.sections)) {
      errors.push('字段 sections 必须是数组');
    }

    const rule = {
      name: data.name || '未命名规则',
      description: data.description || '',
      version: data.version || '1.0',
      globalNamingPattern: data.globalNamingPattern || null,
      globalSignatureRequired: !!data.globalSignatureRequired,
      globalExpiryField: data.globalExpiryField || null,
      globalPageRange: data.globalPageRange || null,
      sections: [],
      _sourcePath: sourcePath
    };

    if (data.sections && Array.isArray(data.sections)) {
      const seenNames = new Set();
      const orderMap = new Map();
      data.sections.forEach((section, idx) => {
        const prefix = `sections[${idx}]`;
        try {
          const validated = this.validateSection(section, idx, prefix, seenNames, errors, warnings);
          rule.sections.push(validated);
          const orderKey = String(validated.order);
          if (!orderMap.has(orderKey)) {
            orderMap.set(orderKey, []);
          }
          orderMap.get(orderKey).push({ name: validated.name, index: idx });
        } catch (e) {
          if (e instanceof RuleValidationError) {
            errors.push(e.message);
          } else {
            throw e;
          }
        }
      });

      for (const [order, entries] of orderMap.entries()) {
        if (entries.length > 1) {
          const names = entries.map(e => `"${e.name}"(索引${e.index})`).join(', ');
          errors.push(`章节 order 冲突: order=${order} 被 ${names} 同时使用`);
        }
      }
    }

    if (rule.globalNamingPattern) {
      try {
        new RegExp(rule.globalNamingPattern);
      } catch (e) {
        errors.push(`globalNamingPattern 正则表达式无效: ${e.message}`);
      }
    }

    return { rule, errors, warnings };
  }

  validateSection(section, idx, prefix, seenNames, errors, warnings) {
    if (!section || typeof section !== 'object') {
      throw new RuleValidationError(`${prefix} 必须是对象`, prefix);
    }

    if (!section.name) {
      errors.push(`${prefix}.name 是必填项`);
    } else if (typeof section.name !== 'string') {
      errors.push(`${prefix}.name 必须是字符串`);
    } else if (seenNames.has(section.name)) {
      errors.push(`${prefix}.name "${section.name}" 与其他章节重名`);
    } else {
      seenNames.add(section.name);
    }

    if (typeof section.order !== 'undefined' && typeof section.order !== 'number') {
      errors.push(`${prefix}.order 必须是数字`);
    }

    const validated = {
      name: section.name || `章节_${idx + 1}`,
      order: typeof section.order === 'number' ? section.order : idx + 1,
      directory: section.directory || null,
      description: section.description || '',
      requiredFiles: [],
      namingPatterns: [],
      pageRange: section.pageRange || null,
      expiryField: section.expiryField || null,
      signatureRequired: !!section.signatureRequired,
      allowUntracked: !!section.allowUntracked
    };

    if (validated.directory && typeof validated.directory !== 'string') {
      errors.push(`${prefix}.directory 必须是字符串`);
      validated.directory = null;
    }

    if (section.requiredFiles) {
      if (!Array.isArray(section.requiredFiles)) {
        errors.push(`${prefix}.requiredFiles 必须是数组`);
      } else {
        section.requiredFiles.forEach((file, fIdx) => {
          const fp = `${prefix}.requiredFiles[${fIdx}]`;
          try {
            validated.requiredFiles.push(this.validateRequiredFile(file, fp, errors));
          } catch (e) {
            if (e instanceof RuleValidationError) {
              errors.push(e.message);
            }
          }
        });
      }
    }

    if (section.namingPatterns) {
      if (!Array.isArray(section.namingPatterns)) {
        errors.push(`${prefix}.namingPatterns 必须是数组`);
        validated.namingPatterns = [];
      } else {
        section.namingPatterns.forEach((pattern, pIdx) => {
          const pp = `${prefix}.namingPatterns[${pIdx}]`;
          try {
            validated.namingPatterns.push(this.validateNamingPattern(pattern, pp, errors));
          } catch (e) {
            if (e instanceof RuleValidationError) {
              errors.push(e.message);
            }
          }
        });
      }
    }

    if (validated.pageRange) {
      if (typeof validated.pageRange === 'string') {
        const m = validated.pageRange.match(/^(\d+)\s*[-~]\s*(\d+)$/);
        if (m) {
          validated.pageRange = { start: parseInt(m[1]), end: parseInt(m[2]) };
        } else {
          errors.push(`${prefix}.pageRange 格式无效，应为 "起始-结束" 如 "1-50"`);
          validated.pageRange = null;
        }
      } else if (typeof validated.pageRange === 'object') {
        if (typeof validated.pageRange.start !== 'number' || typeof validated.pageRange.end !== 'number') {
          errors.push(`${prefix}.pageRange.start/end 必须是数字`);
          validated.pageRange = null;
        }
      } else {
        errors.push(`${prefix}.pageRange 格式无效`);
        validated.pageRange = null;
      }
    }

    if (validated.expiryField) {
      if (typeof validated.expiryField === 'string') {
        validated.expiryField = { fieldName: validated.expiryField };
      } else if (typeof validated.expiryField === 'object') {
        if (!validated.expiryField.fieldName) {
          errors.push(`${prefix}.expiryField.fieldName 是必填项`);
        }
        if (validated.expiryField.dateFormat && typeof validated.expiryField.dateFormat !== 'string') {
          errors.push(`${prefix}.expiryField.dateFormat 必须是字符串`);
        }
      } else {
        errors.push(`${prefix}.expiryField 必须是字符串或对象`);
        validated.expiryField = null;
      }
    }

    return validated;
  }

  validateRequiredFile(file, prefix, errors) {
    if (typeof file === 'string') {
      return {
        path: file,
        name: null,
        exact: true,
        optional: false,
        signatureRequired: null,
        pageRange: null,
        description: ''
      };
    }

    if (typeof file !== 'object') {
      throw new RuleValidationError(`${prefix} 必须是字符串或对象`, prefix);
    }

    if (!file.path) {
      errors.push(`${prefix}.path 是必填项`);
    } else if (typeof file.path !== 'string') {
      errors.push(`${prefix}.path 必须是字符串`);
    }

    return {
      path: file.path || '',
      name: file.name || null,
      exact: file.exact !== false,
      optional: !!file.optional,
      signatureRequired: file.signatureRequired !== undefined ? !!file.signatureRequired : null,
      pageRange: file.pageRange || null,
      description: file.description || ''
    };
  }

  validateNamingPattern(pattern, prefix, errors) {
    if (typeof pattern === 'string') {
      let regex;
      try {
        regex = new RegExp(pattern);
      } catch (e) {
        errors.push(`${prefix} 正则表达式无效: ${e.message}`);
        return { pattern: '.*', label: '无效模式', regex: /.*$/ };
      }
      return {
        pattern: pattern,
        label: pattern,
        regex: regex,
        extractVersion: false
      };
    }

    if (typeof pattern !== 'object') {
      throw new RuleValidationError(`${prefix} 必须是字符串或对象`, prefix);
    }

    if (!pattern.pattern) {
      errors.push(`${prefix}.pattern 是必填项`);
    }

    let regex;
    try {
      regex = new RegExp(pattern.pattern || '.*');
    } catch (e) {
      errors.push(`${prefix}.pattern 正则表达式无效: ${e.message}`);
      regex = /.*$/;
    }

    return {
      pattern: pattern.pattern || '.*',
      label: pattern.label || pattern.pattern || '',
      regex: regex,
      extractVersion: !!pattern.extractVersion,
      versionGroup: pattern.versionGroup || 1
    };
  }
}

module.exports = {
  RuleParser,
  RuleValidationError
};
