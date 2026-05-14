/**
 * 默认 forbidden_paths：所有 task / project 默认禁动的敏感路径。
 *
 * 设计原则：宁可误伤也不漏过。这些路径要么含密钥、要么含 CI/部署配置、
 * 要么是 git 自身元数据。一般任务永远不应碰它们。
 *
 * 用户可以在 task md 的 safety.forbidden_paths 或 config.yml 的 projects[].safety
 * 中覆盖（追加或替换）。Runner 把 task-level 和这里的默认合并取并集。
 */
export const DEFAULT_FORBIDDEN_PATHS: readonly string[] = [
  // 环境变量与本地秘钥
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.test',
  'secrets/',
  'secret/',

  // 各种语言的包管理 auth
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pypirc',
  '.cargo/credentials',
  '.cargo/credentials.toml',

  // SSH / cloud
  '.ssh/',
  '.aws/',
  '.kube/',
  '.gcp/',
  '.azure/',
  '.config/gcloud/',

  // 私钥模式（safety-gate 走前缀和扩展名 glob 匹配）
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '*.pem',
  '*.key',
  '*.pfx',
  '*.p12',

  // git 元数据：不让 task 改 .git/config（攻击面：可改 origin、hooks）
  '.git/config',
  '.git/hooks/',

  // CI/CD：让 idleloop 改 GitHub Actions / GitLab CI 是高危
  '.github/workflows/',
  '.gitlab-ci.yml',
  '.circleci/',
  'azure-pipelines.yml',
  'Jenkinsfile',

  // 容器 / 部署
  'Dockerfile.production',
  'k8s/',
  'kubernetes/',
  'terraform/',

  // 浏览器存储 / Mac keychain 之类
  '.netrc',
  '.gnupg/',
];
