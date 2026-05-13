import { Command } from 'commander';
import { TaskParseError } from '../curator/index.js';
import { generateUnitForCurrentPlatform } from '../daemon/index.js';
import { runAdd } from './commands/add.js';
import {
  runDaemonStart,
  runDaemonStatus,
  runDaemonStop,
  runDaemonUnit,
} from './commands/daemon.js';
import { runDoctor } from './commands/doctor.js';
import { runInit } from './commands/init.js';
import { formatListTable, runList } from './commands/list.js';
import { runLogs } from './commands/logs.js';
import { runReview } from './commands/review.js';
import { runRun } from './commands/run.js';
import { formatHuman, formatJson, runStatus } from './commands/status.js';
import { EXAMPLE_TASK_MD } from './commands/task-template.js';

const program = new Command();

program
  .name('idleloop')
  .description('Use your soon-to-reset Claude Code quota while you sleep.')
  .version('0.0.0');

program
  .command('init')
  .description('Initialize idleloop config and directories, and verify your OAuth token.')
  .option('-f, --force', 'overwrite existing config.yml', false)
  .option('--skip-verify', 'do not call /api/oauth/profile to verify the token', false)
  .action(async (opts: { force: boolean; skipVerify: boolean }) => {
    const r = await runInit(opts);
    if (r.configCreated) {
      console.log(`✓ Wrote default config to ${r.configPath}`);
    } else {
      console.log(`· Config already exists at ${r.configPath} (use --force to overwrite)`);
    }
    console.log(`✓ Created ${r.directoriesCreated.length} directories under idleloop roots`);
    if (r.exampleTaskCreated) {
      console.log(`✓ Wrote example task: ${r.exampleTaskPath}`);
    }
    if (r.authenticatedAs) {
      console.log(`✓ Authenticated as ${r.authenticatedAs}`);
    }
    for (const w of r.warnings) {
      console.warn(`! ${w}`);
    }
    console.log('');
    console.log('Next steps:');
    console.log(
      `  1. Edit ${r.exampleTaskPath ?? '~/idleloop/queue/example.md.template'}, then rename to .md`,
    );
    console.log('  2. Edit ~/idleloop/config.yml to register your projects');
    console.log('  3. `idleloop doctor` — verify your environment is ready');
    console.log('  4. `idleloop run --dry` — preview what would happen tonight');
    console.log(
      '  5. `idleloop daemon unit > ~/.config/systemd/user/idleloop.service` (Linux) — when you trust it',
    );
  });

program
  .command('status')
  .description('Print current Claude Code quota and reset countdowns.')
  .option('--json', 'machine-readable JSON output', false)
  .action(async (opts: { json: boolean }) => {
    const { snapshot } = await runStatus({ json: opts.json });
    if (opts.json) {
      console.log(formatJson(snapshot));
    } else {
      console.log(formatHuman(snapshot));
    }
  });

program
  .command('add <file>')
  .description('Validate a task markdown file and copy it into ~/idleloop/queue/.')
  .action(async (file: string) => {
    try {
      const r = await runAdd(file);
      console.log(`✓ Added task ${r.taskId}: ${r.title}`);
      console.log(`  → ${r.destPath}`);
    } catch (err) {
      if (err instanceof TaskParseError) {
        console.error(`[idleloop] ${err.message}`);
        console.error('');
        console.error('Need an example? Run:');
        console.error('  idleloop task template > my-task.md');
        process.exit(1);
      }
      throw err;
    }
  });

program
  .command('list')
  .description('List tasks currently in ~/idleloop/queue/.')
  .action(async () => {
    const { tasks } = await runList();
    console.log(formatListTable(tasks));
  });

const task = program.command('task').description('Task file helpers.');
task
  .command('template')
  .description('Print a fully-commented example task markdown to stdout.')
  .action(() => {
    process.stdout.write(EXAMPLE_TASK_MD);
  });

program
  .command('doctor')
  .description('Run environment checks (config, token, claude CLI, projects, worktree base).')
  .option('--skip-network', 'do not call /api/oauth/profile', false)
  .action(async (opts: { skipNetwork: boolean }) => {
    const r = await runDoctor({ skipNetwork: opts.skipNetwork });
    if (!r.ok) process.exit(1);
  });

program
  .command('run')
  .description('Run one trigger evaluation + task pipeline (single shot).')
  .option(
    '--dry',
    'preview mode: bypass quiet_hours / activity / policy gates and show what WOULD run; no claude is called',
    false,
  )
  .option('--force', 'ignore trigger decision and actually run anyway (calls claude)', false)
  .option('--write-shift-log', 'persist a shift log even on --dry', false)
  .action(async (opts: { dry: boolean; force: boolean; writeShiftLog: boolean }) => {
    const summary = await runRun(opts);
    console.log('');
    console.log(
      `Summary: ${summary.results.length} task(s) executed, ` +
        `${summary.results.filter((r) => r.status === 'success').length} success, ` +
        `${summary.results.filter((r) => r.status === 'dry_run').length} dry-run.`,
    );
    if (summary.snapshot) {
      const fiveRem = summary.snapshot.fiveHour.remainingPct.toFixed(0);
      const sevenRem = summary.snapshot.sevenDay.remainingPct.toFixed(0);
      console.log(`Quota: 5h=${fiveRem}% remaining · 7d=${sevenRem}% remaining`);
    }
    if (summary.shift) {
      console.log(`Shift log: ${summary.shift.shiftMdPath}`);
    }
  });

program
  .command('logs')
  .description('Browse shift logs from previous idleloop runs.')
  .option('--date <date>', 'show a specific date (YYYY-MM-DD); default: most recent')
  .option('--list', 'list all dates instead of showing a single day', false)
  .option('--raw', 'print shift.md verbatim', false)
  .option('--recent <n>', 'when --list, limit to most recent N days', (v) => parseInt(v, 10))
  .option('--json', 'machine-readable JSON output', false)
  .action(
    async (opts: {
      date?: string;
      list: boolean;
      raw: boolean;
      recent?: number;
      json: boolean;
    }) => {
      await runLogs(opts);
    },
  );

program
  .command('review')
  .description('Interactively review queued successful tasks (merge / discard / keep).')
  .option('--date <date>', 'only review shifts on this date')
  .option('--auto-merge-only', 'skip everything except confidence=auto_merge tasks', false)
  .option('--limit <n>', 'process at most N tasks', (v) => parseInt(v, 10))
  .option('-y, --yes', 'skip the y/N confirmation before merge', false)
  .action(async (opts: { date?: string; autoMergeOnly: boolean; limit?: number; yes: boolean }) => {
    await runReview({
      ...opts,
      confirmMerge: !opts.yes,
    });
  });

const daemon = program
  .command('daemon')
  .description('Manage the idleloop daemon (start/stop/status/unit).');

daemon
  .command('start')
  .description(
    'Start the daemon loop in the foreground (intended for systemd / launchd / containers).',
  )
  .option('--foreground', '(default) run in foreground', false)
  .option('--max-iterations <n>', 'stop after N iterations (debugging)', (v) => parseInt(v, 10))
  .option('--interval-ms <n>', 'override poll interval in ms', (v) => parseInt(v, 10))
  .action(async (opts: { foreground: boolean; maxIterations?: number; intervalMs?: number }) => {
    const controller = new AbortController();
    let signaled = false;
    const onSig = (sig: NodeJS.Signals) => {
      if (signaled) {
        console.error(`\n[idleloop] received ${sig} twice, force exiting`);
        process.exit(130);
      }
      signaled = true;
      console.error(`\n[idleloop] ${sig} received, finishing current iteration...`);
      controller.abort();
    };
    process.on('SIGTERM', onSig);
    process.on('SIGINT', onSig);
    try {
      await runDaemonStart(opts, { signal: controller.signal });
    } finally {
      process.off('SIGTERM', onSig);
      process.off('SIGINT', onSig);
    }
  });

daemon
  .command('stop')
  .description('Signal the running daemon to stop.')
  .option('--wait-ms <n>', 'graceful shutdown timeout before SIGKILL', (v) => parseInt(v, 10))
  .action(async (opts: { waitMs?: number }) => {
    await runDaemonStop(opts);
  });

daemon
  .command('status')
  .description('Show whether the daemon is running.')
  .action(async () => {
    await runDaemonStatus();
  });

daemon
  .command('unit')
  .description('Print a systemd (Linux) or launchd (macOS) unit file to stdout.')
  .option('--install-hints', '(default) print install instructions on stderr', true)
  .action((opts: { installHints: boolean }) => {
    const u = generateUnitForCurrentPlatform();
    if (opts.installHints !== false) {
      process.stderr.write(`# Save the next stdout block to:\n`);
      process.stderr.write(`#   ${u.installPath}\n`);
      if (u.kind === 'systemd') {
        process.stderr.write(`# Then run:\n`);
        process.stderr.write(`#   systemctl --user daemon-reload\n`);
        process.stderr.write(`#   systemctl --user enable --now idleloop\n`);
        process.stderr.write(`#   journalctl --user -u idleloop -f   # follow logs\n`);
      } else {
        process.stderr.write(`# Then run:\n`);
        process.stderr.write(`#   launchctl bootstrap gui/$(id -u) ${u.installPath}\n`);
        process.stderr.write(`#   launchctl enable gui/$(id -u)/com.idleloop.daemon\n`);
      }
      process.stderr.write(`\n`);
    }
    runDaemonUnit();
  });

program
  .command('abort')
  .description('Stop the daemon AND signal any in-flight claude subprocesses to terminate.')
  .option('--wait-ms <n>', 'graceful shutdown timeout before SIGKILL', (v) => parseInt(v, 10))
  .action(async (opts: { waitMs?: number }) => {
    await runDaemonStop(opts);
    console.log('Note: in-flight claude subprocesses are killed by the daemon process death.');
    console.log('To verify nothing is left, run: ps -ef | grep -i claude');
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[idleloop] ${message}`);
  process.exit(1);
});
