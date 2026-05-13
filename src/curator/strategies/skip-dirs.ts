/**
 * 所有 T3 策略共享的跳过目录列表。
 *
 * 原则：跳过的是「不会有用户产物的目录」，包括：
 *   - 依赖目录（node_modules、venv、target）
 *   - 构建产物（dist、build、out、coverage、.next）
 *   - 元数据（.git、.cache、.idea、.vscode）
 *   - idleloop 自己的工作空间（_references 是用户的开源参考源码）
 */
export const SHARED_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.cache',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.idea',
  '.vscode',
  '_references',
  'docs-dist',
  'vendor',
  'tmp',
]);
