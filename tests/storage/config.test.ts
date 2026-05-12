import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ConfigError,
  ConfigNotFoundError,
  defaultConfig,
  loadConfig,
  parseConfig,
  writeDefaultConfig,
} from '../../src/storage/config.js';

describe('config', () => {
  const originalHome = process.env['HOME'];
  let testHome: string;

  beforeEach(async () => {
    testHome = await mkdtemp(path.join(tmpdir(), 'idleloop-config-'));
    process.env['HOME'] = testHome;
  });

  afterEach(async () => {
    process.env['HOME'] = originalHome;
    await rm(testHome, { recursive: true, force: true });
  });

  describe('defaultConfig', () => {
    it('返回完整结构的默认配置', () => {
      const cfg = defaultConfig();
      expect(cfg.version).toBe(1);
      expect(cfg.watcher.poll_interval_minutes).toBe(15);
      expect(cfg.trigger.policies).toHaveLength(2);
      expect(cfg.trigger.policies[0]?.window).toBe('five_hour');
      expect(cfg.trigger.policies[1]?.window).toBe('seven_day');
      expect(cfg.trigger.quiet_hours).toEqual({ start: 8, end: 22 });
      expect(cfg.runner.default_max_budget_usd).toBe(1.0);
      expect(cfg.projects).toEqual([]);
      expect(cfg.logging.level).toBe('info');
    });
  });

  describe('parseConfig', () => {
    it('接受空对象走全套 default', () => {
      const cfg = parseConfig({});
      expect(cfg.version).toBe(1);
    });

    it('部分覆盖：watcher.poll_interval_minutes', () => {
      const cfg = parseConfig({ watcher: { poll_interval_minutes: 5 } });
      expect(cfg.watcher.poll_interval_minutes).toBe(5);
      expect(cfg.watcher.fallback_to_cli).toBe(true);
    });

    it('quiet_hours=null 允许（用户显式关闭）', () => {
      const cfg = parseConfig({ trigger: { quiet_hours: null } });
      expect(cfg.trigger.quiet_hours).toBeNull();
    });

    it('字段类型错抛 ConfigError', () => {
      expect(() => parseConfig({ watcher: { poll_interval_minutes: 'fast' } })).toThrow(
        ConfigError,
      );
    });

    it('policy.window 必须是 enum', () => {
      expect(() =>
        parseConfig({
          trigger: {
            policies: [{ window: 'monthly', hours_before_reset: 1, min_remaining_pct: 30 }],
          },
        }),
      ).toThrow(ConfigError);
    });

    it('project 缺 id/dir 抛错', () => {
      expect(() => parseConfig({ projects: [{ id: '' }] })).toThrow(ConfigError);
    });

    it('合法 project 通过', () => {
      const cfg = parseConfig({
        projects: [
          {
            id: 'foo',
            dir: '~/workspace/foo',
            strategies: [{ name: 'audit', confidence: 'review_queue' }],
          },
        ],
      });
      expect(cfg.projects[0]?.id).toBe('foo');
      expect(cfg.projects[0]?.weight).toBe(1);
      expect(cfg.projects[0]?.safety.max_diff_lines).toBe(800);
    });
  });

  describe('loadConfig', () => {
    it('缺文件抛 ConfigNotFoundError', async () => {
      await expect(loadConfig(path.join(testHome, 'missing.yml'))).rejects.toThrow(
        ConfigNotFoundError,
      );
    });

    it('合法 YAML 通过', async () => {
      const p = path.join(testHome, 'config.yml');
      await writeFile(
        p,
        `version: 1
watcher:
  poll_interval_minutes: 10
`,
      );
      const cfg = await loadConfig(p);
      expect(cfg.watcher.poll_interval_minutes).toBe(10);
    });

    it('非法 YAML 抛 ConfigError', async () => {
      const p = path.join(testHome, 'bad.yml');
      await writeFile(p, ': : : invalid');
      await expect(loadConfig(p)).rejects.toThrow(ConfigError);
    });
  });

  describe('writeDefaultConfig', () => {
    it('首次写：created=true', async () => {
      const r = await writeDefaultConfig();
      expect(r.created).toBe(true);
      const content = await readFile(r.path, 'utf-8');
      expect(content).toContain('version: 1');
      expect(content).toContain('idleloop config');
    });

    it('文件已存在且 overwrite=false：created=false', async () => {
      await writeDefaultConfig();
      const r = await writeDefaultConfig();
      expect(r.created).toBe(false);
    });

    it('overwrite=true 强写', async () => {
      const p = path.join(testHome, 'idleloop', 'config.yml');
      await writeDefaultConfig({ filePath: p });
      await writeFile(p, 'tampered: true');
      const r = await writeDefaultConfig({ filePath: p, overwrite: true });
      expect(r.created).toBe(true);
      const content = await readFile(p, 'utf-8');
      expect(content).toContain('version: 1');
    });

    it('default 文件能被 loadConfig 解析', async () => {
      const r = await writeDefaultConfig();
      const cfg = await loadConfig(r.path);
      expect(cfg.version).toBe(1);
      expect(cfg.trigger.policies).toHaveLength(2);
    });
  });
});
