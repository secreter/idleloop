import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * 双根目录：
 * - userDataRoot: 用户经常编辑的内容（config、queue、goals、proposals）
 * - stateRoot: 工具私有运行时状态（worktrees、logs、quota 历史、daemon pid）
 *
 * 双根设计参考 XDG：用户配置走 ~/idleloop（友好路径），工具状态走 ~/.idleloop（隐藏）。
 */
function userDataRoot(): string {
  return path.join(homedir(), 'idleloop');
}

function stateRoot(): string {
  return path.join(homedir(), '.idleloop');
}

export const paths = {
  userDataRoot,
  stateRoot,

  configFile: () => path.join(userDataRoot(), 'config.yml'),
  queueDir: () => path.join(userDataRoot(), 'queue'),
  goalsFile: () => path.join(userDataRoot(), 'goals.yml'),
  proposalsDir: () => path.join(userDataRoot(), 'proposals'),
  historyFile: () => path.join(userDataRoot(), 'history.jsonl'),

  stateDir: () => path.join(stateRoot(), 'state'),
  quotaJsonl: () => path.join(stateRoot(), 'state', 'quota.jsonl'),
  daemonPid: () => path.join(stateRoot(), 'state', 'daemon.pid'),

  worktreesDir: () => path.join(stateRoot(), 'worktrees'),
  worktreeFor: (taskId: string) => path.join(stateRoot(), 'worktrees', taskId),

  logsDir: () => path.join(stateRoot(), 'logs'),
  logsForDate: (date: string) => path.join(stateRoot(), 'logs', date),
  shiftMd: (date: string) => path.join(stateRoot(), 'logs', date, 'shift.md'),
  shiftStateJson: (date: string) => path.join(stateRoot(), 'logs', date, 'state.json'),
  claudeOutputLog: (date: string) => path.join(stateRoot(), 'logs', date, 'claude-output.log'),
  daemonLog: () => path.join(stateRoot(), 'logs', 'daemon.log'),

  // Claude Code 自己的目录（只读用）
  claudeCredentials: () => path.join(homedir(), '.claude', '.credentials.json'),
  claudeProjectsDir: () => path.join(homedir(), '.claude', 'projects'),
};

/**
 * 递归 mkdir，权限默认 0o700（仅 owner）。
 * EXIST 不报错。
 */
export async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true, mode: 0o700 });
}

/**
 * 把 `~` 前缀展开为 home 目录的绝对路径。
 * 配置里允许用户写 `~/...`，运行时统一展开。
 */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

/**
 * 返回今天的 yyyy-mm-dd（本地时区）。logs/{date} 用。
 */
export function todayDateString(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
