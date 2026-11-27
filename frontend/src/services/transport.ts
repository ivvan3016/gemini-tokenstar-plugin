import {
  App,
  PostMessageTransport,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import type {
  SkyDataResponse,
  UpdateApplyResult,
  UpdateCheckResult,
} from '../types/sky';

export interface ExportSaveResult {
  status: 'saved';
  path: string;
  filename: string;
  bytes: number;
}

export interface DataTransport {
  mode: 'mcp' | 'http';
  getSkyData(): Promise<SkyDataResponse>;
  refresh(): Promise<SkyDataResponse>;
  saveExportPng?(pngBase64: string, filename: string): Promise<ExportSaveResult>;
  checkUpdate?(): Promise<UpdateCheckResult>;
  applyUpdate?(tag?: string): Promise<UpdateApplyResult>;
  openExternalUrl?(url: string): Promise<void>;
  dispose(): void;
}

interface McpToolResultLike {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 2500;

function isInsideIframe(): boolean {
  try {
    return typeof window !== 'undefined' && window.parent !== window;
  } catch {
    // Cross-origin frame access throws SecurityError inside sandboxed hosts.
    return true;
  }
}

function applyHostContext(ctx: McpUiHostContext | undefined): void {
  if (!ctx) return;
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
}

function unwrapMcpResult<T>(
  result: McpToolResultLike,
  isValid: (value: unknown) => value is T,
  invalidMessage: string,
): T {
  if (result.isError) {
    const errText = result.content
      ?.filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    throw new Error(errText || 'MCP tool returned an error');
  }

  if (result.structuredContent && isValid(result.structuredContent)) {
    return result.structuredContent;
  }

  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        try {
          const parsed = JSON.parse(block.text) as unknown;
          if (isValid(parsed)) {
            return parsed;
          }
        } catch {
          continue;
        }
      }
    }
  }

  throw new Error(invalidMessage);
}

function isSkyDataResponse(value: unknown): value is SkyDataResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as Partial<SkyDataResponse>).conversations)
  );
}

function isExportSaveResult(value: unknown): value is ExportSaveResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ExportSaveResult>;
  return (
    candidate.status === 'saved' &&
    typeof candidate.path === 'string' &&
    candidate.path.length > 0 &&
    typeof candidate.filename === 'string' &&
    typeof candidate.bytes === 'number'
  );
}

function isUpdateCheckResult(value: unknown): value is UpdateCheckResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<UpdateCheckResult>;
  return (
    (candidate.status === 'ok' || candidate.status === 'error') &&
    typeof candidate.current_version === 'string' &&
    typeof candidate.has_update === 'boolean' &&
    typeof candidate.can_self_update === 'boolean' &&
    typeof candidate.release_url === 'string'
  );
}

function isUpdateApplyResult(value: unknown): value is UpdateApplyResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<UpdateApplyResult>;
  return (
    candidate.status === 'updated' &&
    typeof candidate.updated_version === 'string' &&
    typeof candidate.backend_changed === 'boolean' &&
    typeof candidate.restart_required === 'boolean' &&
    typeof candidate.message === 'string'
  );
}

function openBrowserExternalUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Only http/https URLs can be opened externally.');
  }
  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export function extractSkyData(result: McpToolResultLike): SkyDataResponse {
  return unwrapMcpResult(
    result,
    isSkyDataResponse,
    'Invalid SkyDataResponse payload returned from MCP tool',
  );
}

export function extractExportSaveResult(result: McpToolResultLike): ExportSaveResult {
  return unwrapMcpResult(
    result,
    isExportSaveResult,
    'Invalid ExportSaveResult payload returned from MCP tool',
  );
}

export function extractUpdateCheckResult(result: McpToolResultLike): UpdateCheckResult {
  return unwrapMcpResult(
    result,
    isUpdateCheckResult,
    'Invalid UpdateCheckResult payload returned from MCP tool',
  );
}

export function extractUpdateApplyResult(result: McpToolResultLike): UpdateApplyResult {
  return unwrapMcpResult(
    result,
    isUpdateApplyResult,
    'Invalid UpdateApplyResult payload returned from MCP tool',
  );
}

function createHttpTransport(): DataTransport {
  return {
    mode: 'http',
    async getSkyData(): Promise<SkyDataResponse> {
      const response = await fetch('/api/sky-data');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} fetching /api/sky-data`);
      }
      return (await response.json()) as SkyDataResponse;
    },
    async refresh(): Promise<SkyDataResponse> {
      const response = await fetch('/api/refresh', { method: 'POST' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} calling /api/refresh`);
      }
      return (await response.json()) as SkyDataResponse;
    },
    async checkUpdate(): Promise<UpdateCheckResult> {
      const response = await fetch('/api/check-update');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} fetching /api/check-update`);
      }
      const payload = (await response.json()) as unknown;
      if (!isUpdateCheckResult(payload)) {
        throw new Error('Invalid UpdateCheckResult payload returned from /api/check-update');
      }
      return payload;
    },
    async applyUpdate(tag?: string): Promise<UpdateApplyResult> {
      const response = await fetch('/api/apply-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tag ? { tag } : {}),
      });
      const payload = (await response.json().catch(() => null)) as
        | (Partial<UpdateApplyResult> & { error?: string })
        | null;
      if (!response.ok) {
        throw new Error(payload?.error || `HTTP ${response.status} calling /api/apply-update`);
      }
      if (!isUpdateApplyResult(payload)) {
        throw new Error('Invalid UpdateApplyResult payload returned from /api/apply-update');
      }
      return payload;
    },
    async openExternalUrl(url: string): Promise<void> {
      openBrowserExternalUrl(url);
    },
    dispose(): void {
      // No persistent connection to tear down in HTTP mode.
    },
  };
}

function createMcpTransport(app: App): DataTransport {
  return {
    mode: 'mcp',
    async getSkyData(): Promise<SkyDataResponse> {
      const result = await app.callServerTool({
        name: 'tokenstar_get_sky_data',
        arguments: {},
      });
      return extractSkyData(result as McpToolResultLike);
    },
    async refresh(): Promise<SkyDataResponse> {
      const result = await app.callServerTool({
        name: 'tokenstar_refresh',
        arguments: {},
      });
      return extractSkyData(result as McpToolResultLike);
    },
    async saveExportPng(pngBase64: string, filename: string): Promise<ExportSaveResult> {
      const result = await app.callServerTool({
        name: 'tokenstar_save_export',
        arguments: { png_base64: pngBase64, filename },
      });
      return extractExportSaveResult(result as McpToolResultLike);
    },
    async checkUpdate(): Promise<UpdateCheckResult> {
      const result = await app.callServerTool({
        name: 'tokenstar_check_update',
        arguments: {},
      });
      return extractUpdateCheckResult(result as McpToolResultLike);
    },
    async applyUpdate(tag?: string): Promise<UpdateApplyResult> {
      const result = await app.callServerTool({
        name: 'tokenstar_apply_update',
        arguments: tag ? { tag } : {},
      });
      return extractUpdateApplyResult(result as McpToolResultLike);
    },
    async openExternalUrl(url: string): Promise<void> {
      if (!/^https?:\/\//i.test(url)) {
        throw new Error('Only http/https URLs can be opened externally.');
      }
      try {
        const res = await app.openLink({ url });
        if (!res?.isError) return;
      } catch {
        // Fallback to window.open if host rejects openLink.
      }
      openBrowserExternalUrl(url);
    },
    dispose(): void {
      void app.close().catch(() => undefined);
    },
  };
}

/**
 * Create a dual-mode data transport: attempts MCP App handshake when embedded in
 * an iframe host, and falls back cleanly to local HTTP endpoints otherwise.
 */
export async function createTransport(
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<DataTransport> {
  if (!isInsideIframe()) {
    return createHttpTransport();
  }

  const app = new App({ name: 'TokenStar', version: '0.1.2' }, {}, { autoResize: true });
  app.onhostcontextchanged = (ctx) => {
    applyHostContext(ctx);
  };

  let timerId: ReturnType<typeof setTimeout> | undefined;
  try {
    const connectPromise = app.connect(
      new PostMessageTransport(window.parent, window.parent),
    );
    // Avoid unhandled rejection if connect rejects after timeout wins the race.
    connectPromise.catch(() => undefined);
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timerId = setTimeout(() => {
        reject(new Error(`MCP connect timed out after ${connectTimeoutMs}ms`));
      }, connectTimeoutMs);
    });

    await Promise.race([connectPromise, timeoutPromise]);
    applyHostContext(app.getHostContext());
    return createMcpTransport(app);
  } catch {
    void app.close().catch(() => undefined);
    return createHttpTransport();
  } finally {
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }
  }
}
