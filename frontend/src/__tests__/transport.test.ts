import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkyDataResponse } from '../types/sky';
import {
  createTransport,
  extractExportSaveResult,
  extractSkyData,
} from '../services/transport';

const samplePayload: SkyDataResponse = {
  schema_version: '1.0',
  generated_at: '2026-11-25T10:00:00Z',
  scan_duration_ms: 12.5,
  sources: [],
  conversations: [],
};

describe('transport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('test_http_fallback_outside_mcp_host', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => samplePayload,
    });
    vi.stubGlobal('fetch', fetchMock);

    // Default jsdom has window.parent === window (not inside an iframe)
    const transport = await createTransport(50);
    expect(transport.mode).toBe('http');

    const initial = await transport.getSkyData();
    expect(initial).toEqual(samplePayload);
    expect(fetchMock).toHaveBeenCalledWith('/api/sky-data');

    const refreshed = await transport.refresh();
    expect(refreshed).toEqual(samplePayload);
    expect(fetchMock).toHaveBeenCalledWith('/api/refresh', { method: 'POST' });

    transport.dispose();
  });

  it('falls back to http when inside iframe and MCP connect times out', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => samplePayload,
    });
    vi.stubGlobal('fetch', fetchMock);

    const parentSpy = vi.spyOn(window, 'parent', 'get').mockReturnValue({
      postMessage: vi.fn(),
    } as unknown as Window);

    const transport = await createTransport(30);
    expect(transport.mode).toBe('http');
    parentSpy.mockRestore();

    await transport.getSkyData();
    expect(fetchMock).toHaveBeenCalledWith('/api/sky-data');
    transport.dispose();
  });

  it('skips leading non-JSON text blocks when extracting SkyDataResponse from MCP content', () => {
    const parsed = extractSkyData({
      content: [
        { type: 'text', text: 'TokenStar observatory snapshot ready.' },
        { type: 'text', text: '{"not_sky_data": true}' },
        { type: 'text', text: JSON.stringify(samplePayload) },
      ],
    });
    expect(parsed).toEqual(samplePayload);
  });

  it('extracts ExportSaveResult from structuredContent or text fallback and throws on isError', () => {
    const saved = {
      status: 'saved' as const,
      path: 'C:/Users/demo/Downloads/tokenstar-wallpaper-2x.png',
      filename: 'tokenstar-wallpaper-2x.png',
      bytes: 1280,
    };

    expect(extractExportSaveResult({ structuredContent: saved })).toEqual(saved);
    expect(
      extractExportSaveResult({
        content: [{ type: 'text', text: JSON.stringify(saved) }],
      }),
    ).toEqual(saved);

    expect(() =>
      extractExportSaveResult({
        isError: true,
        content: [{ type: 'text', text: 'Permission denied' }],
      }),
    ).toThrow('Permission denied');
  });
});
