const disabledExternalFeatures = {
  multi_agent: false,
  apps: false,
  computer_use: false,
  browser_use: false,
  browser_use_external: false,
  image_generation: false,
  in_app_local_automation: false,
  goals: false,
  sleep_tool: false,
};

export function isolatedToolConfig(config, pluginRestrictions = {}, { shellTool }) {
  if (!config || typeof config !== 'object') throw new Error('Effective Codex configuration is unavailable');
  const overrides = {
    features: { shell_tool: shellTool, ...disabledExternalFeatures },
    apps: { _default: { enabled: false } },
    mcp_servers: {},
    plugins: structuredClone(pluginRestrictions),
    web_search: 'disabled',
  };
  for (const name of Object.keys(config.mcp_servers ?? {})) {
    overrides.mcp_servers[name] = { enabled: false, required: false };
  }
  for (const name of Object.keys(config.apps ?? {})) overrides.apps[name] = { enabled: false };
  return overrides;
}

export async function unexpectedMcpServers(client, threadId, errorMessage) {
  let cursor;
  const unexpected = [];
  do {
    const page = await client.request('mcpServerStatus/list', {
      threadId,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(page?.data)) throw new Error(errorMessage);
    unexpected.push(...page.data.filter(server =>
      server.runtimeStatus !== 'disabled' || Object.keys(server.tools ?? {}).length));
    cursor = page.nextCursor;
  } while (cursor);
  return unexpected;
}

export function pluginMcpRestrictions(current, servers) {
  if (servers.some(server => typeof server.pluginId !== 'string' || !server.pluginId.trim()
    || typeof server.name !== 'string' || !server.name.trim())) return null;
  const restrictions = structuredClone(current);
  for (const server of servers) {
    const plugin = restrictions[server.pluginId] ??= { mcp_servers: {} };
    plugin.mcp_servers ??= {};
    plugin.mcp_servers[server.name] = { enabled: false };
  }
  return restrictions;
}
