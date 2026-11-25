import {
  App,
  PostMessageTransport,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import type { SkyDataResponse } from '../types/sky';

export interface DataTransport {
  mode: 'mcp' | 'http';
  getSkyData(): Promise<SkyDataResponse>;
  refresh(): Promise<SkyDataResponse>;
  dispose(): void;
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

export function extractSkyData(result: {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
}): SkyDataResponse {
  if (result.isError) {
    const errText = result.content
      ?.filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    throw new Error(errText || 'MCP tool returned an error');
  }

  if (
    result.structuredContent &&
    Array.isArray(result.structuredContent.conversations)
  ) {
    return result.structuredContent as unknown as SkyDataResponse;
  }

  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        try {
          const parsed = JSON.parse(block.text) as Partial<SkyDataResponse>;
          if (parsed && Array.isArray(parsed.conversations)) {
            return parsed as SkyDataResponse;
          }
        } catch {
          continue;
        }
      }
    }
  }

  throw new Error('Invalid SkyDataResponse payload returned from MCP tool');
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
      return extractSkyData(
        result as {
          isError?: boolean;
          structuredContent?: Record<string, unknown>;
          content?: Array<{ type: string; text?: string }>;
        },
      );
    },
    async refresh(): Promise<SkyDataResponse> {
      const result = await app.callServerTool({
        name: 'tokenstar_refresh',
        arguments: {},
      });
      return extractSkyData(
        result as {
          isError?: boolean;
          structuredContent?: Record<string, unknown>;
          content?: Array<{ type: string; text?: string }>;
        },
      );
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

  const app = new App({ name: 'TokenStar', version: '0.1.0' }, {}, { autoResize: true });
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
