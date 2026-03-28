import { describe, it, expect } from 'vitest';
import { buildMcpConfig } from './buildMcpConfig.js';

describe('buildMcpConfig', () => {
  const baseParams = { mcpPort: 3100, secret: 'test-secret-token' };

  it('includes only neuroforge server when botMemoryUrl is null', () => {
    const config = buildMcpConfig({ ...baseParams, botMemoryUrl: null });

    expect(config.mcpServers).toHaveProperty('neuroforge');
    expect(config.mcpServers).not.toHaveProperty('bot-memory');
    expect(config.mcpServers.neuroforge).toEqual({
      type: 'sse',
      url: 'http://localhost:3100/sse',
      headers: { Authorization: 'Bearer test-secret-token' },
    });
  });

  it('includes only neuroforge server when botMemoryUrl is undefined', () => {
    const config = buildMcpConfig({ ...baseParams });

    expect(config.mcpServers).toHaveProperty('neuroforge');
    expect(config.mcpServers).not.toHaveProperty('bot-memory');
  });

  it('includes bot-memory server when botMemoryUrl is provided', () => {
    const config = buildMcpConfig({
      ...baseParams,
      botMemoryUrl: 'http://127.0.0.1:3099',
    });

    expect(config.mcpServers).toHaveProperty('neuroforge');
    expect(config.mcpServers).toHaveProperty('bot-memory');
    expect(config.mcpServers['bot-memory']).toEqual({
      type: 'sse',
      url: 'http://127.0.0.1:3099/sse',
    });
  });

  it('does not include auth headers for bot-memory server', () => {
    const config = buildMcpConfig({
      ...baseParams,
      botMemoryUrl: 'http://127.0.0.1:3099',
    });

    expect(config.mcpServers['bot-memory']).not.toHaveProperty('headers');
  });

  it('uses correct port in neuroforge URL', () => {
    const config = buildMcpConfig({ mcpPort: 4200, secret: 's', botMemoryUrl: null });

    expect(config.mcpServers.neuroforge.url).toBe('http://localhost:4200/sse');
  });
});
