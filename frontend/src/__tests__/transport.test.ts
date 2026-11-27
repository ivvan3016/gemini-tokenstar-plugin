import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SkyDataResponse,
  UpdateApplyResult,
  UpdateCheckResult,
} from '../types/sky';
import {
  createTransport,
  extractExportSaveResult,
  extractSkyData,
  extractUpdateApplyResult,
  extractUpdateCheckResult,
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

  it('extracts update check/apply results and calls HTTP update endpoints', async () => {
    const checkSample: UpdateCheckResult = {
      status: 'ok',
      current_version: '0.1.1',
      latest_version: '0.2.0',
      tag_name: 'v0.2.0',
      has_update: true,
      can_self_update: true,
      has_bundle_asset: true,
      release_url: 'https://github.com/ivvan3016/gemini-tokenstar-plugin/releases/tag/v0.2.0',
      published_at: '2026-11-27T10:00:00Z',
      release_notes: 'Added self-update',
      error: null,
    };
    const applySample: UpdateApplyResult = {
      status: 'updated',
      previous_version: '0.1.1',
      updated_version: '0.2.0',
      backend_changed: true,
      restart_required: true,
      sync_deferred: false,
      message: '已更新至 v0.2.0（包含后端改动），请关闭并重新打开 Antigravity 即可生效。',
    };

    expect(extractUpdateCheckResult({ structuredContent: { ...checkSample } })).toEqual(checkSample);
    expect(
      extractUpdateCheckResult({
        content: [{ type: 'text', text: JSON.stringify(checkSample) }],
      }),
    ).toEqual(checkSample);
    expect(() =>
      extractUpdateCheckResult({
        isError: true,
        content: [{ type: 'text', text: 'Network error' }],
      }),
    ).toThrow('Network error');

    expect(extractUpdateApplyResult({ structuredContent: { ...applySample } })).toEqual(applySample);
    expect(
      extractUpdateApplyResult({
        content: [{ type: 'text', text: JSON.stringify(applySample) }],
      }),
    ).toEqual(applySample);
    expect(() =>
      extractUpdateApplyResult({
        isError: true,
        content: [{ type: 'text', text: 'Apply failed' }],
      }),
    ).toThrow('Apply failed');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => checkSample,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => applySample,
      });
    vi.stubGlobal('fetch', fetchMock);

    const transport = await createTransport(50);
    expect(await transport.checkUpdate?.()).toEqual(checkSample);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/check-update');

    expect(await transport.applyUpdate?.('v0.2.0')).toEqual(applySample);
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/apply-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: 'v0.2.0' }),
    });
    transport.dispose();
  });
});
