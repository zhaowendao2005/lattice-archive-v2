/**
 * ============================================================================
 * [DATA SOURCE] 批量无头会话导入薄桥接器 (sessionBatchImporter.ts)
 * ============================================================================
 * 定位：仅作为 Store 与底层 `src/worker/local/sessionBatchParser.ts` 实现域之间的薄桥接层。
 */
import {
  DEFAULT_DEVICE_FINGERPRINT,
  encodeGramJsStringSession,
  parseSessionFiles,
  parseSessionTextLines,
  type ParsedImportedSessionItem,
} from '@/worker/local/sessionBatchParser';

export { DEFAULT_DEVICE_FINGERPRINT, encodeGramJsStringSession, type ParsedImportedSessionItem };

class SessionBatchImporterBridge {
  public parseTextLines(rawText: string): ParsedImportedSessionItem[] {
    return parseSessionTextLines(rawText);
  }

  public parseFiles(files: FileList | File[]): Promise<ParsedImportedSessionItem[]> {
    return parseSessionFiles(files);
  }
}

export const sessionBatchImporter = new SessionBatchImporterBridge();
