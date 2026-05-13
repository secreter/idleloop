import { describe, expect, it } from 'vitest';
import { selectByWeight } from '../../src/curator/scheduler.js';
import type { ProjectConfig } from '../../src/storage/config.js';
import type { Task } from '../../src/types/task.js';

function task(id: string, project: string): Task {
  return {
    id,
    source: 'T1',
    project,
    title: id,
    prompt: 'x',
    working_dir: '/tmp',
    cost_estimate_tokens: 100,
    acceptance: '',
    verify_command: 'true',
    confidence: 'review_queue',
    budget_usd: 0.1,
    safety: { max_diff_lines: 100, forbidden_paths: [] },
  };
}

function proj(id: string, weight: number): ProjectConfig {
  return {
    id,
    dir: `/tmp/${id}`,
    weight,
    strategies: [],
    safety: { max_diff_lines: 100, forbidden_paths: [] },
  };
}

describe('selectByWeight', () => {
  it('空 projects → 原顺序截断', () => {
    const tasks = [task('1', 'a'), task('2', 'a'), task('3', 'b')];
    const out = selectByWeight(tasks, { projects: [], maxTasks: 2 });
    expect(out.map((t) => t.id)).toEqual(['1', '2']);
  });

  it('权重 3:1：项目 a 出 3 个，b 出 1 个（cap=4）', () => {
    const tasks = [
      task('a-1', 'a'),
      task('a-2', 'a'),
      task('a-3', 'a'),
      task('a-4', 'a'),
      task('b-1', 'b'),
      task('b-2', 'b'),
    ];
    const out = selectByWeight(tasks, {
      projects: [proj('a', 3), proj('b', 1)],
      maxTasks: 4,
    });
    const ids = out.map((t) => t.id);
    expect(ids.filter((s) => s.startsWith('a-')).length).toBe(3);
    expect(ids.filter((s) => s.startsWith('b-')).length).toBe(1);
  });

  it('某项目任务不够时不会卡死，继续填充其他项目', () => {
    const tasks = [task('a-1', 'a'), task('b-1', 'b'), task('b-2', 'b'), task('b-3', 'b')];
    const out = selectByWeight(tasks, {
      projects: [proj('a', 3), proj('b', 1)],
      maxTasks: 4,
    });
    expect(out.map((t) => t.id).sort()).toEqual(['a-1', 'b-1', 'b-2', 'b-3'].sort());
  });

  it('未配置 weight 的项目按 weight=1 处理', () => {
    const tasks = [task('a-1', 'a'), task('a-2', 'a'), task('c-1', 'c')];
    const out = selectByWeight(tasks, {
      projects: [proj('a', 1)], // c 未配置
      maxTasks: 10,
    });
    expect(out.map((t) => t.id).sort()).toEqual(['a-1', 'a-2', 'c-1']);
  });

  it('maxTasks=0 返回空', () => {
    const tasks = [task('a-1', 'a')];
    const out = selectByWeight(tasks, { projects: [proj('a', 1)], maxTasks: 0 });
    expect(out).toEqual([]);
  });

  it('权重相同时按 tasks 中首次出现顺序稳定排序', () => {
    // b 在 tasks 数组中先出现，权重也相同
    const tasks = [task('b-1', 'b'), task('a-1', 'a'), task('b-2', 'b'), task('a-2', 'a')];
    const out = selectByWeight(tasks, {
      projects: [proj('a', 1), proj('b', 1)],
      maxTasks: 4,
    });
    // 第一轮取 b 再取 a（b 先出现），第二轮同理
    expect(out.map((t) => t.id)).toEqual(['b-1', 'a-1', 'b-2', 'a-2']);
  });

  it('weight=0 的项目不会被选', () => {
    const tasks = [task('a-1', 'a'), task('b-1', 'b')];
    const out = selectByWeight(tasks, {
      projects: [proj('a', 0), proj('b', 1)],
      maxTasks: 10,
    });
    expect(out.map((t) => t.project)).toEqual(['b']);
  });
});
