/**
 * Hello World Plugin — A simple example plugin for NewClaw.
 *
 * Plugins are .js files in the plugins/ directory that default-export
 * a tool definition with a name, description, parameters, and execute function.
 */

export default {
  name: 'hello',
  description: 'A simple hello world greeting tool',
  parameters: {
    name: { type: 'string', description: 'Name to greet', required: false },
  },
  permissionLevel: 0, // FREE — no approval needed
  execute: async (args) => {
    const name = args.name || 'World';
    return {
      tool: 'hello',
      success: true,
      output: `Hello, ${name}! 👋 This response comes from a NewClaw plugin.`,
    };
  },
};
