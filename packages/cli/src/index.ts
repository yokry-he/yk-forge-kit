#!/usr/bin/env node
const [command] = process.argv.slice(2);
if (command === 'version' || command === '--version') {
  console.log('ForgeKit CLI 0.0.0');
} else if (command === 'help' || command === '--help' || !command) {
  console.log('ForgeKit CLI (bootstrap)\n\nCommands:\n  version   Show CLI version\n  help      Show this help');
} else {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}
