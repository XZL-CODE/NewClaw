/**
 * NewClaw — Main Entry Point
 *
 * Assembles all modules and starts the autonomous AI loop.
 *
 * Architecture:
 *   Config → Memory → Events → Channels → Tools → Context → Provider → MasterLoop
 */

import { loadConfig } from './config/loader.js';
import { createProvider } from './providers/index.js';
import { MemoryService } from './memory/index.js';
import { EventCollector } from './core/event-collector.js';
import { ContextAssembler } from './core/context-assembler.js';
import { ModelReasoning } from './core/model-reasoning.js';
import { ActionExecutor } from './core/action-executor.js';
import { MasterLoop } from './core/master-loop.js';
import { PermissionBoundary } from './core/permission.js';
import { createAllChannels } from './channels/factory.js';
import { registerAllTools, type EventContextRef } from './tools/index.js';
import { MissionRunner } from './mission/index.js';
import { McpClient } from './mcp/index.js';
import { PluginLoader } from './plugins/index.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './core/logger.js';
import { metrics } from './core/metrics.js';

async function main(): Promise<void> {
  // 1. Load configuration
  const config = loadConfig();

  if (!config.apiKey) {
    logger.error('Main', 'API key is required. Set NEWCLAW_API_KEY, ANTHROPIC_API_KEY, or the appropriate provider key via env or config.json');
    process.exit(1);
  }

  // 2. Initialize MemoryService
  const memoryService = new MemoryService(config.memoryDbPath);

  // 3. Initialize EventCollector (with optional webhook server)
  const events = new EventCollector(config.webhookPort || undefined);

  // 4. Initialize Channels (via factory — no hardcoded switch/case here)
  const channels = createAllChannels(config.channels);

  if (channels.size === 0) {
    logger.error('Main', 'No channels configured. At least one channel must be enabled.');
    process.exit(1);
  }

  // 5. Initialize ActionExecutor
  const executor = new ActionExecutor(config.permissions);

  // 5a. Initialize Provider and ModelReasoning (needed by MissionRunner before tool registration)
  const provider = createProvider({
    provider: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    maxTokens: config.maxTokens,
    baseUrl: config.baseUrl,
  });
  const reasoning = new ModelReasoning(provider, config.model, config.maxTokens);
  logger.info('Main', `Using provider: ${provider.name}, model: ${config.model}`);

  // Inject LLM capability into MemoryService for LLM-driven reflection
  memoryService.setLLMCall(async (prompt: string) => {
    const response = await provider.chat(
      [{ role: 'user', content: prompt }],
      { model: config.model, maxTokens: 500 },
    );
    return response.content;
  });

  // 5b. Initialize MissionRunner
  const missionRunner = new MissionRunner(memoryService.database, reasoning, executor, events);

  // Shared mutable ref updated by MasterLoop's event processing (for mission_create to capture source channel)
  const eventContextRef: EventContextRef = { channel: 'terminal', replyTo: 'user' };

  // Register all tools (including mission tools)
  registerAllTools(executor, { channels, memoryService, eventCollector: events, db: memoryService.database, missionRunner, eventContextRef });

  // 5b. Connect MCP servers and register their tools
  const mcpClients: McpClient[] = [];
  if (config.mcpServers?.length) {
    for (const serverConfig of config.mcpServers) {
      const client = new McpClient(serverConfig);
      try {
        await client.connect();
        client.registerTools(executor);
        mcpClients.push(client);
      } catch (err) {
        logger.error('MCP', `Failed to connect to "${serverConfig.name}":`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  // 5c. Load plugins from plugins/ directory
  const __dirname_main = dirname(fileURLToPath(import.meta.url));
  const pluginsDir = join(__dirname_main, '..', 'plugins');
  const pluginLoader = new PluginLoader(pluginsDir);
  await pluginLoader.loadAll(executor);

  // 6. Set up permission boundary for approval flow
  const permissionBoundary = new PermissionBoundary(config.permissions);
  const primaryChannel = channels.values().next().value!;

  executor.setApprovalCallback(async (tool, args) => {
    return permissionBoundary.requestApproval(tool, args, primaryChannel);
  });

  // 7. Initialize ContextAssembler (with MissionStore for active mission context injection)
  const context = new ContextAssembler(config, memoryService);
  context.setMissionStore(missionRunner.getStore());

  // 8. Create MasterLoop
  const loop = new MasterLoop(config, events, context, reasoning, executor);

  // Wire response delivery: route responses back to the originating channel
  const responseCallback = async (channelName: string, content: string, replyTo: string) => {
    const ch = channels.get(channelName);
    if (ch) {
      await ch.sendMessage(replyTo, content);
    }
  };
  loop.setResponseCallback(responseCallback);

  // Update event context ref when an event starts processing (before reasoning/tool execution)
  // This ensures mission_create captures the correct source channel (e.g. 'feishu' not 'terminal')
  loop.setEventStartCallback((channel, replyTo) => {
    eventContextRef.channel = channel;
    eventContextRef.replyTo = replyTo;
  });

  // Wire MissionRunner's response callback with channel fallback
  // If the stored sourceChannel doesn't exist (e.g. was saved incorrectly), try other active channels
  missionRunner.setResponseCallback(async (channelName, content, replyTo) => {
    // 优先发到 sourceChannel
    const primaryCh = channels.get(channelName);
    if (primaryCh && channelName !== 'terminal') {
      await primaryCh.sendMessage(replyTo, content);
      return;
    }
    // fallback：发到第一个非 terminal 通道
    for (const [name, ch] of channels) {
      if (name !== 'terminal') {
        await ch.sendMessage(replyTo, content);
        return;
      }
    }
    // 最后兜底：terminal
    const termCh = channels.get('terminal');
    if (termCh) {
      await termCh.sendMessage(replyTo, content);
    }
  });

  // Wire streaming: send text chunks to channel adapters that support it
  loop.setStreamCallback((channelName, chunk) => {
    const ch = channels.get(channelName);
    if (ch?.streamText) {
      ch.streamText(chunk);
    }
  });

  // Wire memory persistence
  loop.setMemoryCallback(async (note) => {
    memoryService.addEpisode(note, ['auto']);
  });

  // Add bot self-filter if feishu is configured (avoid echo loops)
  for (const chConfig of config.channels) {
    if (chConfig.type === 'feishu' && chConfig.options?.appId) {
      events.addBotFilter(String(chConfig.options.appId));
    }
  }

  // 10. Connect all channels and wire events into the collector
  for (const [name, channel] of channels) {
    channel.onMessage((event) => {
      events.push(event.source, event.channel, event.data, event.priority);
    });
    try {
      await channel.connect();
    } catch (err) {
      logger.error('Main', `Failed to connect channel "${name}":`, err);
      channels.delete(name);
    }
  }

  if (channels.size === 0) {
    logger.error('Main', 'All channels failed to connect.');
    process.exit(1);
  }

  // 11. Restore active missions
  missionRunner.restoreActive();

  // 12. Start the MasterLoop
  logger.info('Main', `NewClaw starting with ${channels.size} channel(s): ${[...channels.keys()].join(', ')}`);
  const loopPromise = loop.start();

  // 12. Graceful shutdown
  const shutdown = async () => {
    logger.info('Main', 'Shutting down...');
    missionRunner.stopAll();
    await loop.stop();

    for (const client of mcpClients) {
      client.disconnect();
    }

    for (const [, channel] of channels) {
      await channel.disconnect();
    }

    memoryService.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await loopPromise;
}

main().catch((err) => {
  logger.error('Main', 'Fatal error:', err);
  process.exit(1);
});
