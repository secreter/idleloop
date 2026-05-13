import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { expandHome } from '../../storage/paths.js';
import type { Task } from '../../types/task.js';
import { logger as rootLogger } from '../../utils/logger.js';
import type { CuratorStrategy } from '../types.js';
import { SHARED_SKIP_DIRS } from './skip-dirs.js';

const log = rootLogger.child({ mod: 'curator', strategy: 'audit' });

export interface AuditProjectInput {
  /** 项目 id（出现在生成的 task.project 字段里） */
  id: string;
  /** 项目根目录（支持 ~） */
  dir: string;
  /** 文件扩展名白名单；默认 .ts/.tsx/.js/.jsx/.py/.go/.rs/.md */
  extensions?: string[];
  /** 限制扫描深度；默认 6（避免扫 node_modules 等深目录） */
  maxDepth?: number;
  /** 命中阈值；< 1 不生成任务，>= maxFindings 截断 */
  minFindings?: number;
  maxFindings?: number;
  confidence?: Task['confidence'];
  /** 单次扫描最大文件数硬上限，防扫疯 */
  maxFiles?: number;
}

export interface AuditFinding {
  filePath: string;
  line: number;
  marker: 'TODO' | 'FIXME' | 'XXX' | 'HACK';
  text: string;
}

export interface AuditOptions {
  projects: AuditProjectInput[];
  /** 测试可注入：把文件系统操作替换掉 */
  readDirFn?: typeof readdir;
  readFileFn?: typeof readFile;
}

const SKIP_DIRS = SHARED_SKIP_DIRS;

const MARKER_RE = /\b(TODO|FIXME|XXX|HACK)\b\s*[:：-]?\s*(.*)$/;

/**
 * T3 audit 策略：扫项目 TODO / FIXME / XXX / HACK 标记。
 *
 * 命中后生成一个聚合任务：让 Claude 把这些 marker 转为可执行的修复或拆 issue。
 */
export class AuditStrategy implements CuratorStrategy {
  readonly name = 'audit';
  readonly source = 'T3' as const;

  constructor(private readonly opts: AuditOptions) {}

  async discover(): Promise<Task[]> {
    const out: Task[] = [];
    for (const project of this.opts.projects) {
      try {
        const t = await this.scanProject(project);
        if (t) out.push(t);
      } catch (err) {
        log.warn({ project: project.id, err: (err as Error).message }, 'audit scan failed');
      }
    }
    return out;
  }

  private async scanProject(project: AuditProjectInput): Promise<Task | null> {
    const exts = project.extensions ?? ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.md'];
    const maxFiles = project.maxFiles ?? 5_000;
    const maxFindings = project.maxFindings ?? 50;
    const minFindings = project.minFindings ?? 3;
    const maxDepth = project.maxDepth ?? 6;
    const root = expandHome(project.dir);
    const findings: AuditFinding[] = [];

    let scanned = 0;
    await this.walk(root, 0, maxDepth, async (filePath) => {
      if (scanned >= maxFiles || findings.length >= maxFindings) return;
      const ext = path.extname(filePath).toLowerCase();
      if (!exts.includes(ext)) return;
      scanned++;
      const reader = this.opts.readFileFn ?? readFile;
      let content: string;
      try {
        content = await reader(filePath, 'utf-8');
      } catch {
        return;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (findings.length >= maxFindings) return;
        const line = lines[i]!;
        const m = MARKER_RE.exec(line);
        if (!m) continue;
        const marker = m[1] as AuditFinding['marker'];
        const text = (m[2] ?? '').trim().slice(0, 120);
        findings.push({ filePath: path.relative(root, filePath), line: i + 1, marker, text });
      }
    });

    if (findings.length < minFindings) {
      log.debug(
        { project: project.id, findings: findings.length, minFindings },
        'audit: below threshold, skipping task',
      );
      return null;
    }

    const prompt = buildAuditPrompt(project, findings);
    const taskId = `task-audit-${project.id}-${ulid().slice(-8).toLowerCase()}`;
    return {
      id: taskId,
      source: 'T3',
      project: project.id,
      title: `audit: triage ${findings.length} markers in ${project.id}`,
      prompt,
      working_dir: root,
      cost_estimate_tokens: 4_000 + 200 * findings.length,
      acceptance: 'reduce TODO/FIXME count or convert markers into actionable tasks',
      verify_command: 'true',
      confidence: project.confidence ?? 'review_queue',
      budget_usd: 0.6,
      safety: { max_diff_lines: 600, forbidden_paths: ['.env', 'secrets/'] },
    };
  }

  private async walk(
    dir: string,
    depth: number,
    maxDepth: number,
    visit: (filePath: string) => Promise<void>,
  ): Promise<void> {
    if (depth > maxDepth) return;
    const reader = this.opts.readDirFn ?? readdir;
    let entries: Dirent[];
    try {
      entries = (await reader(dir, { withFileTypes: true })) as unknown as Dirent[];
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT' || e.code === 'EACCES' || e.code === 'ENOTDIR') return;
      throw err;
    }
    for (const ent of entries) {
      if (SKIP_DIRS.has(ent.name)) continue;
      if (ent.name.startsWith('.') && ent.name !== '.github') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await this.walk(full, depth + 1, maxDepth, visit);
      } else if (ent.isFile()) {
        await visit(full);
      }
    }
  }
}

function buildAuditPrompt(project: AuditProjectInput, findings: AuditFinding[]): string {
  const list = findings
    .map((f) => `- ${f.filePath}:${f.line}  ${f.marker}: ${f.text || '(no message)'}`)
    .join('\n');
  return [
    `项目 ${project.id} 内还有 ${findings.length} 条未处理的代码标记 (TODO/FIXME/XXX/HACK)。`,
    '',
    '任务：',
    '1. 阅读下列标记，把每条归类到「能在本仓库直接修复」「需要更多上下文」「已过时可以删除」。',
    '2. 对「能直接修复」的，直接改代码并提交。',
    '3. 对「需要更多上下文」的，在原位置补充必要信息（链接、负责人、目标行为）。',
    '4. 对「已过时」的，删除该 marker 注释。',
    '',
    '严格要求：',
    '- 不引入新的 TODO/FIXME，除非你正在 marker 旁边把场景写清楚。',
    '- 单次最多改 600 行 diff（safety 限制），超过就先处理你最有把握的一批。',
    '- 不修改 .env、secrets/ 路径下任何文件。',
    '',
    `Markers:`,
    list,
  ].join('\n');
}
