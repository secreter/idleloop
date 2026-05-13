import type { ProjectConfig } from '../storage/config.js';
import type { Task } from '../types/task.js';

export interface ScheduleOptions {
  /** 项目权重表；未在表中的项目按 weight=1 处理 */
  projects: ProjectConfig[];
  /** 总最多取几个 task；不传 = 不限 */
  maxTasks?: number;
}

/**
 * 多项目调度：按 project.weight 在多项目任务里做加权 round-robin 选择。
 *
 * 例：weight llm-infra=3, coffeesmap=1
 *   - 项目 a 有 5 个任务，项目 b 有 5 个
 *   - maxTasks=4 → 输出 3 个 a + 1 个 b（按权重）
 *
 * 实现：把每个项目的任务按到原顺序排队，重复轮询，每轮按权重决定本轮谁出多少个。
 * 单轮一次扫所有项目，每个项目最多吐出 ceil(weight / minWeight) 个。
 *
 * 没有 projects 配置（空数组）时 → 不调度，直接原顺序截断到 maxTasks。
 */
export function selectByWeight(tasks: Task[], opts: ScheduleOptions): Task[] {
  const cap = opts.maxTasks ?? tasks.length;
  if (cap <= 0) return [];

  if (opts.projects.length === 0) {
    return tasks.slice(0, cap);
  }

  const weightMap = new Map<string, number>();
  for (const p of opts.projects) {
    weightMap.set(p.id, Math.max(p.weight, 0));
  }

  const byProject = new Map<string, Task[]>();
  // 保持插入顺序（也保留出现顺序）
  for (const t of tasks) {
    const arr = byProject.get(t.project) ?? [];
    arr.push(t);
    byProject.set(t.project, arr);
  }

  // 第一遍：把没有权重配置的项目按 weight=1 加入
  for (const project of byProject.keys()) {
    if (!weightMap.has(project)) weightMap.set(project, 1);
  }

  const minWeight = Math.min(...Array.from(weightMap.values()).filter((w) => w > 0));
  if (!Number.isFinite(minWeight) || minWeight <= 0) {
    return tasks.slice(0, cap);
  }

  const perRound = new Map<string, number>();
  for (const [proj, w] of weightMap.entries()) {
    if (w <= 0) continue;
    perRound.set(proj, Math.max(1, Math.round(w / minWeight)));
  }

  const out: Task[] = [];
  // 项目轮询顺序：按 weight 降序；相同权重按 task 中首次出现的顺序（稳定）
  const firstSeenIndex = new Map<string, number>();
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!;
    if (!firstSeenIndex.has(t.project)) firstSeenIndex.set(t.project, i);
  }
  const projectOrder = Array.from(perRound.keys()).sort((a, b) => {
    const wa = perRound.get(a) ?? 0;
    const wb = perRound.get(b) ?? 0;
    if (wa !== wb) return wb - wa;
    return (firstSeenIndex.get(a) ?? Infinity) - (firstSeenIndex.get(b) ?? Infinity);
  });

  let progress = true;
  while (out.length < cap && progress) {
    progress = false;
    for (const proj of projectOrder) {
      if (out.length >= cap) break;
      const queue = byProject.get(proj);
      if (!queue || queue.length === 0) continue;
      const take = Math.min(perRound.get(proj) ?? 0, queue.length, cap - out.length);
      for (let i = 0; i < take; i++) {
        const task = queue.shift();
        if (!task) break;
        out.push(task);
      }
      if (take > 0) progress = true;
    }
  }
  return out;
}
