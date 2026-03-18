/**
 * PluginLoader — Dynamically load tool plugins from the plugins/ directory.
 *
 * Each plugin is a .js file that default-exports a standard tool interface.
 * Failed plugins are logged but don't block other plugins from loading.
 */

import { readdir } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { pathToFileURL } from 'url';
import type { ActionExecutor } from '../core/action-executor.js';
import type { ToolDefinition, ToolParameter, ActionResult } from '../types/index.js';
import { PermissionLevel } from '../types/index.js';

/** The shape a plugin file must default-export. */
export interface PluginExport {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  permissionLevel?: number; // Maps to PermissionLevel enum
  execute: (args: Record<string, unknown>) => Promise<ActionResult>;
}

export class PluginLoader {
  constructor(private pluginsDir: string) {}

  /** Scan plugins directory and register all valid plugins with the executor. */
  async loadAll(executor: ActionExecutor): Promise<number> {
    if (!existsSync(this.pluginsDir)) {
      console.log(`[Plugins] Directory not found: ${this.pluginsDir}, skipping.`);
      return 0;
    }

    const files = await readdir(this.pluginsDir);
    const jsFiles = files.filter((f) => f.endsWith('.js'));

    let loaded = 0;
    for (const file of jsFiles) {
      const filePath = join(this.pluginsDir, file);
      try {
        await this.loadOne(filePath, executor);
        loaded++;
      } catch (err) {
        console.error(`[Plugins] Failed to load ${file}:`, err instanceof Error ? err.message : err);
      }
    }

    if (loaded > 0) {
      console.log(`[Plugins] Loaded ${loaded} plugin(s) from ${this.pluginsDir}`);
    }
    return loaded;
  }

  /** Load a single plugin file and register it with the executor. */
  async loadOne(filePath: string, executor: ActionExecutor): Promise<void> {
    const absPath = resolve(filePath);
    const fileUrl = pathToFileURL(absPath).href;
    const mod = await import(fileUrl);
    const plugin: PluginExport = mod.default;

    if (!plugin || !plugin.name || !plugin.execute) {
      throw new Error(`Invalid plugin: must default-export { name, execute, ... }`);
    }

    const definition = this.toToolDefinition(plugin);
    const executorFn = this.wrapExecutor(plugin);
    executor.registerTool(definition.name, definition, executorFn);
  }

  private toToolDefinition(plugin: PluginExport): ToolDefinition {
    const parameters: Record<string, ToolParameter> = {};
    for (const [key, schema] of Object.entries(plugin.parameters ?? {})) {
      const paramType = schema.type as ToolParameter['type'];
      parameters[key] = {
        type: ['string', 'number', 'boolean', 'object', 'array'].includes(paramType) ? paramType : 'string',
        description: schema.description ?? '',
        required: schema.required,
      };
    }

    // Map numeric permission level, default to FREE
    const level = plugin.permissionLevel ?? 0;
    const permissionLevel: PermissionLevel =
      level === 3 ? PermissionLevel.FORBIDDEN :
      level === 2 ? PermissionLevel.APPROVE :
      level === 1 ? PermissionLevel.NOTIFY :
      PermissionLevel.FREE;

    return {
      name: plugin.name,
      description: plugin.description ?? '',
      parameters,
      permissionLevel,
    };
  }

  private wrapExecutor(plugin: PluginExport): (args: Record<string, unknown>) => Promise<ActionResult> {
    return async (args) => {
      try {
        return await plugin.execute(args);
      } catch (err) {
        return {
          tool: plugin.name,
          success: false,
          output: '',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };
  }
}
