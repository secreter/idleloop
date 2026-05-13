import { describe, expect, it } from 'vitest';
import {
  generateLaunchdPlist,
  generateSystemdUnit,
  generateUnitForCurrentPlatform,
} from '../../src/daemon/units.js';

describe('generateSystemdUnit', () => {
  it('含核心字段', () => {
    const u = generateSystemdUnit({
      binary: '/usr/local/bin/idleloop',
      home: '/home/u',
      restartSec: 5,
    });
    expect(u).toContain('[Unit]');
    expect(u).toContain('[Service]');
    expect(u).toContain('ExecStart=/usr/local/bin/idleloop daemon start --foreground');
    expect(u).toContain('Environment=HOME=/home/u');
    expect(u).toContain('RestartSec=5');
    expect(u).toContain('[Install]');
  });
});

describe('generateLaunchdPlist', () => {
  it('XML 良构 + 含 ProgramArguments / HOME', () => {
    const p = generateLaunchdPlist({
      binary: '/usr/local/bin/idleloop',
      home: '/Users/u',
      restartSec: 15,
    });
    expect(p.startsWith('<?xml version="1.0"')).toBe(true);
    expect(p).toContain('<string>com.idleloop.daemon</string>');
    expect(p).toContain('<string>/usr/local/bin/idleloop</string>');
    expect(p).toContain('<string>/Users/u</string>');
    expect(p).toContain('<integer>15</integer>');
    expect(p).toContain('<key>KeepAlive</key>');
  });
});

describe('generateUnitForCurrentPlatform', () => {
  it('当前平台返回内容 + installPath', () => {
    const u = generateUnitForCurrentPlatform({ binary: 'idleloop', home: '/h' });
    expect(['systemd', 'launchd']).toContain(u.kind);
    expect(u.content.length).toBeGreaterThan(50);
    expect(u.installPath.startsWith('/h')).toBe(true);
  });
});
