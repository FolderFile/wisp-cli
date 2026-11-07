import { spawn } from 'node:child_process';
import { ToolError, type Tool } from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;

/** Keep the head and tail of long output; the middle is usually the least useful. */
export function truncateMiddle(s: string, max = MAX_OUTPUT_CHARS): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  const dropped = s.length - max;
  return `${s.slice(0, half)}\n\n… [${dropped} characters truncated] …\n\n${s.slice(-half)}`;
}

export const bashTool: Tool<{ command: string; timeout_ms?: number }> = {
  name: 'bash',
  description:
    'Run a shell command with bash in the working directory and return stdout+stderr and the exit code. ' +
    'Each call is a fresh shell: cd and exported variables do not persist between calls. ' +
    'stdin is closed, so avoid interactive commands (use flags like --yes, or non-interactive modes). ' +
    `Default timeout ${DEFAULT_TIMEOUT_MS / 1000}s, max ${MAX_TIMEOUT_MS / 1000}s.`,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to run' },
      timeout_ms: { type: 'integer', description: 'Timeout in milliseconds' },
    },
    required: ['command'],
  },
  permission: 'exec',
  label: (i) => i.command,
  async preview({ command }) {
    return `$ ${command.split('\n').join('\n  ')}`;
  },
  run({ command, timeout_ms }, ctx) {
    const timeout = Math.min(Math.max(1000, timeout_ms ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      const child = spawn('bash', ['-c', command], {
        cwd: ctx.cwd,
        // Own process group, so we can kill the whole tree and the terminal's
        // Ctrl+C goes to wisp (which then aborts us) rather than straight to the child.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat', TERM: 'dumb', NO_COLOR: '1' },
      });

      let output = '';
      let killedFor: 'timeout' | 'abort' | null = null;
      const onData = (d: Buffer) => {
        output += d.toString('utf8');
        // Bound memory for runaway output; we only keep head+tail anyway.
        if (output.length > MAX_OUTPUT_CHARS * 4) output = truncateMiddle(output, MAX_OUTPUT_CHARS * 2);
        ctx.onUpdate?.(output);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);

      const kill = (why: 'timeout' | 'abort') => {
        killedFor = why;
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      const timer = setTimeout(() => kill('timeout'), timeout);
      const onAbort = () => kill('abort');
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        reject(new ToolError(`Failed to start command: ${err.message}`));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        const out = truncateMiddle(output.trimEnd()) || '(no output)';
        if (killedFor === 'abort') return reject(new ToolError(`Interrupted by user.\n${out}`));
        if (killedFor === 'timeout')
          return reject(new ToolError(`Command timed out after ${timeout / 1000}s.\n${out}`));
        const status = code === 0 ? '' : `\n[exit code ${code ?? signal}]`;
        if (code !== 0) return reject(new ToolError(out + status));
        resolve(out);
      });
    });
  },
};
