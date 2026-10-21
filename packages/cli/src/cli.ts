#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { render } from 'ink';
import { createElement } from 'react';
import { registerWalletCommands } from './commands/wallet.js';
import { registerStreamCommands } from './commands/stream.js';
import { registerProfileCommands } from './commands/profile.js';
import { registerCompletionCommands } from './commands/completion.js';
import { registerMultisigCommands } from './commands/multisig.js';
import StreamTui from './tui/stream-tui.js';

const program = new Command();

program
  .name('stellar-alerts-cli')
  .description('CLI tool for managing Stellar Alerts wallets and streams')
  .version('1.0.0')
  .option('-u, --api-url <url>', 'API base URL', process.env.STELLAR_ALERTS_API_URL || 'http://localhost:3001')
  .option(
    '--profile <name>',
    'Configuration profile to use for this invocation (overrides active profile)',
  );

// Register command groups
registerWalletCommands(program);
registerStreamCommands(program);
registerProfileCommands(program);
registerCompletionCommands(program);
registerMultisigCommands(program);

// Health check command
program
  .command('health')
  .description('Check API health status')
  .action(async () => {
    try {
      const response = await fetch(`${program.opts().apiUrl}/health`);
      if (response.ok) {
        const data = await response.json();
        console.log(chalk.green(`✅ API is healthy: ${JSON.stringify(data)}`));
      } else {
        console.log(chalk.red(`❌ API returned status: ${response.status}`));
        process.exit(1);
      }
    } catch (error) {
      console.log(chalk.red(`❌ API is not reachable: ${(error as Error).message}`));
      process.exit(1);
    }
  });

// TUI Dashboard command
program
  .command('tui')
  .description('Launch interactive Terminal UI (TUI) dashboard')
  .action(() => {
    render(createElement(StreamTui));
  });

// Error handling
program.on('command:*', (operands) => {
  console.error(chalk.red(`❌ Unknown command: ${operands[0]}`));
  console.log('Run --help to see available commands');
  process.exit(1);
});

program.parse(process.argv);
