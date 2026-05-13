import { homedir, platform } from 'node:os';
import path from 'node:path';

export interface UnitGenerateOptions {
  /** idleloop CLI 绝对路径；默认用 process.execPath + 当前 script */
  binary?: string;
  /** systemd unit / plist 中要写的 HOME，默认 process.env.HOME */
  home?: string;
  /** systemd RestartSec / launchd ThrottleInterval，秒 */
  restartSec?: number;
}

/**
 * 生成 systemd user unit 内容。
 *
 * 用户用法：
 *   mkdir -p ~/.config/systemd/user
 *   idleloop daemon unit > ~/.config/systemd/user/idleloop.service
 *   systemctl --user daemon-reload
 *   systemctl --user enable --now idleloop
 */
export function generateSystemdUnit(opts: UnitGenerateOptions = {}): string {
  const binary = opts.binary ?? defaultBinary();
  const home = opts.home ?? homedir();
  const restart = opts.restartSec ?? 10;
  return [
    '[Unit]',
    'Description=idleloop daemon (Claude Code quota-aware AI worker)',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${binary} daemon start --foreground`,
    `Environment=HOME=${home}`,
    `Restart=on-failure`,
    `RestartSec=${restart}`,
    // 让日志走 journald；用户用 journalctl --user -u idleloop -f 查
    'StandardOutput=journal',
    'StandardError=journal',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/**
 * 生成 launchd plist 内容。
 *
 * 用户用法：
 *   idleloop daemon unit > ~/Library/LaunchAgents/com.idleloop.daemon.plist
 *   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.idleloop.daemon.plist
 *   launchctl enable gui/$(id -u)/com.idleloop.daemon
 */
export function generateLaunchdPlist(opts: UnitGenerateOptions = {}): string {
  const binary = opts.binary ?? defaultBinary();
  const home = opts.home ?? homedir();
  const restartSec = opts.restartSec ?? 30;
  const logDir = path.join(home, '.idleloop', 'logs');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>com.idleloop.daemon</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${binary}</string>`,
    '    <string>daemon</string>',
    '    <string>start</string>',
    '    <string>--foreground</string>',
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>HOME</key>',
    `    <string>${home}</string>`,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ThrottleInterval</key>',
    `  <integer>${restartSec}</integer>`,
    '  <key>StandardOutPath</key>',
    `  <string>${path.join(logDir, 'launchd.out.log')}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${path.join(logDir, 'launchd.err.log')}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/**
 * 按当前平台返回合适的 unit 内容。
 */
export function generateUnitForCurrentPlatform(opts: UnitGenerateOptions = {}): {
  kind: 'systemd' | 'launchd';
  content: string;
  installPath: string;
} {
  const p = platform();
  if (p === 'darwin') {
    return {
      kind: 'launchd',
      content: generateLaunchdPlist(opts),
      installPath: `${opts.home ?? homedir()}/Library/LaunchAgents/com.idleloop.daemon.plist`,
    };
  }
  return {
    kind: 'systemd',
    content: generateSystemdUnit(opts),
    installPath: `${opts.home ?? homedir()}/.config/systemd/user/idleloop.service`,
  };
}

function defaultBinary(): string {
  // 跑 from-source 时 process.argv[1] 是 cli/index.ts；
  // 跑 dist 安装时是 ~/.npm/bin/idleloop 之类。两种都让 systemd / launchd 直接 exec。
  if (process.argv[1]) return process.argv[1];
  return 'idleloop';
}
