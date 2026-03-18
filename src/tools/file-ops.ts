/**
 * File Operations Tools — Read, write, search, and grep.
 */

import { readFile as fsReadFile, writeFile as fsWriteFile } from 'fs/promises';
import { glob } from 'fs/promises';
import { execFile } from 'child_process';
import type { ActionResult, ToolDefinition } from '../types/index.js';
import { PermissionLevel } from '../types/index.js';

// --- Tool Definitions ---

export const readFileDef: ToolDefinition = {
  name: 'read_file',
  description: 'Read the contents of a file at the given path.',
  parameters: {
    path: { type: 'string', description: 'Absolute or relative file path', required: true },
  },
  permissionLevel: PermissionLevel.FREE,
};

export const writeFileDef: ToolDefinition = {
  name: 'write_file',
  description: 'Write content to a file, creating it if it does not exist.',
  parameters: {
    path: { type: 'string', description: 'File path to write to', required: true },
    content: { type: 'string', description: 'Content to write', required: true },
  },
  permissionLevel: PermissionLevel.NOTIFY,
};

export const searchFilesDef: ToolDefinition = {
  name: 'search_files',
  description: 'Search for files matching a glob pattern in a directory.',
  parameters: {
    pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts")', required: true },
    dir: { type: 'string', description: 'Directory to search in (defaults to cwd)' },
  },
  permissionLevel: PermissionLevel.FREE,
};

export const grepContentDef: ToolDefinition = {
  name: 'grep_content',
  description: 'Search file contents for lines matching a regex pattern.',
  parameters: {
    pattern: { type: 'string', description: 'Regex pattern to search for', required: true },
    dir: { type: 'string', description: 'Directory to search in (defaults to cwd)' },
  },
  permissionLevel: PermissionLevel.FREE,
};

// --- Executors ---

export async function readFileExecutor(args: Record<string, unknown>): Promise<ActionResult> {
  const path = String(args.path ?? '');
  try {
    const content = await fsReadFile(path, 'utf-8');
    return { tool: 'read_file', success: true, output: content };
  } catch (err) {
    return { tool: 'read_file', success: false, output: '', error: String(err) };
  }
}

export async function writeFileExecutor(args: Record<string, unknown>): Promise<ActionResult> {
  const path = String(args.path ?? '');
  const content = String(args.content ?? '');
  try {
    await fsWriteFile(path, content, 'utf-8');
    return { tool: 'write_file', success: true, output: `Written to ${path}` };
  } catch (err) {
    return { tool: 'write_file', success: false, output: '', error: String(err) };
  }
}

export async function searchFilesExecutor(args: Record<string, unknown>): Promise<ActionResult> {
  const pattern = String(args.pattern ?? '');
  const dir = args.dir ? String(args.dir) : '.';
  try {
    const fullPattern = dir === '.' ? pattern : `${dir}/${pattern}`;
    const matches: string[] = [];
    for await (const entry of glob(fullPattern)) {
      matches.push(entry);
      if (matches.length >= 200) break; // Limit results
    }
    return { tool: 'search_files', success: true, output: matches.join('\n') || 'No matches found.' };
  } catch (err) {
    return { tool: 'search_files', success: false, output: '', error: String(err) };
  }
}

export async function grepContentExecutor(args: Record<string, unknown>): Promise<ActionResult> {
  const pattern = String(args.pattern ?? '');
  const dir = args.dir ? String(args.dir) : '.';

  return new Promise<ActionResult>((resolve) => {
    execFile(
      'grep',
      ['-rn', '--include=*', '-E', pattern, dir],
      { maxBuffer: 1024 * 1024, timeout: 15_000 },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          resolve({
            tool: 'grep_content',
            success: false,
            output: '',
            error: stderr || 'No matches found.',
          });
        } else {
          // Limit output to first 100 lines
          const lines = stdout.split('\n').slice(0, 100);
          resolve({
            tool: 'grep_content',
            success: true,
            output: lines.join('\n'),
          });
        }
      },
    );
  });
}
