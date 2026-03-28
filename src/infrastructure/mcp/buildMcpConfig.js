/**
 * Builds MCP config object for Claude CLI agents.
 *
 * Always includes the neuroforge server (agent tools: report_progress, ask_question, complete).
 * Conditionally includes bot-memory server (pipeline memory: memory_search_pipeline, memory_save_pipeline)
 * when botMemoryUrl is provided.
 *
 * @param {object} params
 * @param {number} params.mcpPort - port of the neuroforge MCP HTTP server
 * @param {string} params.secret - Bearer token for neuroforge MCP auth
 * @param {string|null} [params.botMemoryUrl] - URL of bot-memory MCP server (null = not configured)
 * @returns {{ mcpServers: object }}
 */
export function buildMcpConfig({ mcpPort, secret, botMemoryUrl }) {
  if (botMemoryUrl) {
    try {
      new URL(botMemoryUrl);
    } catch {
      throw new Error(`Invalid BOT_MEMORY_URL: ${botMemoryUrl}`);
    }
  }

  const mcpServers = {
    neuroforge: {
      type: 'sse',
      url: `http://localhost:${mcpPort}/sse`,
      headers: { Authorization: `Bearer ${secret}` },
    },
  };

  if (botMemoryUrl) {
    mcpServers['bot-memory'] = {
      type: 'sse',
      url: `${botMemoryUrl}/sse`,
    };
  }

  return { mcpServers };
}
