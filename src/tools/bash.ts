/**
 * Bash Tool — Execute shell commands with safety checks.
 */

import { execFile } from 'child_process';
import type { ActionResult, ToolDefinition } from '../types/index.js';
import { PermissionLevel } from '../types/index.js';

const DANGEROUS_PATTERNS = [
  /rm\s+(-rf?|--recursive)\s+\//,
  /mkfs\./,
  /dd\s+if=/,
  />\s*\/dev\/sd/,
  /chmod\s+777\s+\//,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}/,  // fork bomb
];

const DEFAULT_TIMEOUT = 30_000; // 30 seconds

export const bashToolDef: ToolDefinition = {
  name: 'bash',
  description: 'Execute a bash command and return stdout/stderr. Has a 30s timeout and dangerous command detection.',
  parameters: {
    command: { type: 'string', description: 'The bash command to execute', required: true },
    cwd: { type: 'string', description: 'Working directory (defaults to project root)' },
    timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
  },
  permissionLevel: PermissionLevel.NOTIFY,
};

export async function executeBash(args: Record<string, unknown>): Promise<ActionResult> {
  const command = String(args.command ?? '');
  const cwd = args.cwd ? String(args.cwd) : undefined;
  const timeout = typeof args.timeout === 'number' ? args.timeout : DEFAULT_TIMEOUT;

  // Check for dangerous commands
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return {
        tool: 'bash',
        success: false,
        output: '',
        error: `Dangerous command blocked: ${command}`,
      };
    }
  }

  return new Promise<ActionResult>((resolve) => {
    execFile(
      '/bin/bash',
      ['-c', command],
      { cwd, timeout, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            tool: 'bash',
            success: false,
            output: stdout,
            error: error.message + (stderr ? `\nstderr: ${stderr}` : ''),
          });
        } else {
          resolve({
            tool: 'bash',
            success: true,
            output: stdout + (stderr ? `\nstderr: ${stderr}` : ''),
          });
        }
      },
    );
  });
}
