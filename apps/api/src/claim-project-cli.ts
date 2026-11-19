import 'dotenv/config';
import { createDatabaseClient } from '@forgekit/db';
import { claimUnownedProject, listUnownedProjects, ProjectClaimError } from './project-claim';

export type ClaimCommand = { kind: 'list' } | { kind: 'claim'; slug: string; issuer: string; subject: string; apply: boolean };

const usage = '用法：\n  pnpm --filter @forgekit/api claim:project -- --list\n' +
  '  pnpm --filter @forgekit/api claim:project -- --slug <项目> --issuer <OIDC issuer> --subject <OIDC subject> [--yes]\n' +
  '不加 --yes 时只做检查（dry-run），不会写入数据库。';

export function parseClaimArgs(argv: string[]): ClaimCommand {
  const args = argv.filter((arg) => arg !== '--');
  if (args.length === 1 && args[0] === '--list') return { kind: 'list' };
  const values: Record<string, string> = {};
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--yes') { apply = true; continue; }
    if (arg === '--slug' || arg === '--issuer' || arg === '--subject') {
      const value = args[index + 1];
      if (!value || value.startsWith('--') || values[arg]) throw new ProjectClaimError(usage);
      values[arg] = value;
      index++;
      continue;
    }
    throw new ProjectClaimError(usage);
  }
  const slug = values['--slug'];
  const issuer = values['--issuer'];
  const subject = values['--subject'];
  if (!slug || !issuer || !subject) throw new ProjectClaimError(usage);
  return { kind: 'claim', slug, issuer, subject, apply };
}

async function main(): Promise<void> {
  const command = parseClaimArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new ProjectClaimError('未配置 DATABASE_URL。');
  const client = createDatabaseClient(process.env.DATABASE_URL);
  try {
    if (command.kind === 'list') {
      const rows = await listUnownedProjects(client.db);
      if (rows.length === 0) console.log('没有缺少成员的旧项目。');
      for (const row of rows) console.log(`${row.slug}\t${row.name}\t${row.createdAt.toISOString()}`);
      return;
    }
    const result = await claimUnownedProject(client.db, command, { apply: command.apply });
    console.log(result.applied
      ? `已将项目 ${result.slug} 的 Owner 设为用户 ${result.userId}，并写入成员审计。`
      : `检查通过（未写入）：项目 ${result.slug} 可由用户 ${result.userId} 认领为 Owner。确认无误后追加 --yes 执行。`);
  } finally {
    await client.close();
  }
}

if (process.argv[1] && /claim-project-cli\.(js|ts)$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof ProjectClaimError ? error.message : error);
    process.exitCode = 1;
  });
}
