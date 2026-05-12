import { Command } from 'commander';
import { runAdd } from './commands/add.js';
import { runInit } from './commands/init.js';
import { formatListTable, runList } from './commands/list.js';
import { runRun } from './commands/run.js';
import { formatHuman, formatJson, runStatus } from './commands/status.js';

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
    if (r.authenticatedAs) {
      console.log(`✓ Authenticated as ${r.authenticatedAs}`);
    }
    for (const w of r.warnings) {
      console.warn(`! ${w}`);
    }
    if (r.warnings.length === 0 && r.authenticatedAs) {
      console.log('');
      console.log('Next: `idleloop status` to check current quota.');
    }
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
    const r = await runAdd(file);
    console.log(`✓ Added task ${r.taskId}: ${r.title}`);
    console.log(`  → ${r.destPath}`);
  });

program
  .command('list')
  .description('List tasks currently in ~/idleloop/queue/.')
  .action(async () => {
    const { tasks } = await runList();
    console.log(formatListTable(tasks));
  });

program
  .command('run')
  .description('Run one trigger evaluation + task pipeline (single shot).')
  .option('--dry', 'do not create worktrees or launch claude; simulate only', false)
  .option('--force', 'ignore trigger decision and run anyway', false)
  .action(async (opts: { dry: boolean; force: boolean }) => {
    const summary = await runRun(opts);
    console.log('');
    console.log(
      `Summary: ${summary.results.length} task(s) executed, ` +
        `${summary.results.filter((r) => r.status === 'success').length} success, ` +
        `${summary.results.filter((r) => r.status === 'dry_run').length} dry-run.`,
    );
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[idleloop] ${message}`);
  process.exit(1);
});
