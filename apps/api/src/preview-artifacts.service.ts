import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { LocalFsArtifactStore, type ArtifactStore } from '@forgekit/artifact-store';
import { isAbsolute } from 'node:path';
import { previewBase } from './preview-config';

@Injectable()
export class PreviewArtifactsService {
  get base(): URL {
    if (!process.env.FORGEKIT_PREVIEW_BASE_URL) throw new ServiceUnavailableException('预览服务尚未配置。');
    return previewBase(process.env);
  }
  get store(): Pick<ArtifactStore, 'open'> {
    const root = process.env.FORGEKIT_ARTIFACT_DIR;
    if (!root || !isAbsolute(root)) throw new ServiceUnavailableException('预览制品存储尚未配置。');
    return new LocalFsArtifactStore(root);
  }
  async requireIndex(key: string): Promise<void> {
    const store = this.store;
    try {
      const file = await store.open(key, 'index.html');
      // Close the descriptor without buffering a potentially large page.
      if (file.close) file.close();
      else for await (const _chunk of file.body) break;
    } catch { throw new ServiceUnavailableException('构建制品暂不可用。'); }
  }
}
