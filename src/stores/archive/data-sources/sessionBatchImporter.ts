/**
 * ============================================================================
 * [DATA SOURCE] 批量无头会话导入薄桥接器 (sessionBatchImporter.ts)
 * ============================================================================
 * 定位：仅作为 Store 与底层 `src/worker/local/sessionBatchParser.ts` 实现域之间的薄桥接层。
 */
import { mtprotoHub } from '@/stores/telegram/data-sources/mtprotoBridge';
import type { ParsedImportedSessionItem, SessionBatchFilePayload } from '@/types/sessionBatch';
export type { ParsedImportedSessionItem } from '@/types/sessionBatch';

class SessionBatchImporterBridge {
  public parseTextLines(rawText: string): Promise<ParsedImportedSessionItem[]> {
    return mtprotoHub.bridge().parseSessionBatch({ mode: 'text', rawText });
  }

  public async parseFiles(files: FileList | File[]): Promise<ParsedImportedSessionItem[]> {
    const payload: SessionBatchFilePayload[] = [];
    for (const file of Array.from(files)) {
      payload.push({ name: file.name, type: file.type, lastModified: file.lastModified, bytes: await file.arrayBuffer() });
    }
    return mtprotoHub.bridge().parseSessionBatch({ mode: 'files', files: payload });
  }
}

export const sessionBatchImporter = new SessionBatchImporterBridge();
