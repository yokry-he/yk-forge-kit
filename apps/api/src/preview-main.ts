import 'dotenv/config';
import { isAbsolute } from 'node:path';
import { createDatabaseClient, validateDatabaseUrl, BuildRepository, PreviewLinkRepository } from '@forgekit/db';
import { LocalFsArtifactStore } from '@forgekit/artifact-store';
import { previewBase } from './preview-config';
import { createPreviewServer } from './preview-server';

async function main(): Promise<void> {
  const base = previewBase(process.env);
  const directory = process.env.FORGEKIT_ARTIFACT_DIR;
  if (!directory || !isAbsolute(directory)) throw new Error('preview_artifact_config');
  const port = Number(process.env.FORGEKIT_PREVIEW_PORT ?? 3002);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('preview_port_config');
  const database = createDatabaseClient(validateDatabaseUrl(process.env.DATABASE_URL));
  const server = createPreviewServer({ base, links: new PreviewLinkRepository(database.db), builds: new BuildRepository(database.db),
    artifacts: new LocalFsArtifactStore(directory), log: (event) => console.info(JSON.stringify(event)) });
  let closing = false;
  const close = () => {
    if (closing) return; closing = true;
    server.close(() => { void database.close(); });
    server.closeIdleConnections();
  };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, process.env.FORGEKIT_PREVIEW_HOST ?? '127.0.0.1', resolve);
    });
    console.info('YKForgeKit preview listening');
  } catch { close(); throw new Error('preview_listen_failed'); }
}
main().catch(() => { console.error('YKForgeKit preview startup failed; check configuration.'); process.exitCode = 1; });
