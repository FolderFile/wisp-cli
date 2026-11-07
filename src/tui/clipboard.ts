import { spawn } from 'node:child_process';

function tryCommand(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
      p.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Copy to the clipboard. OSC 52 works through SSH and tmux in most modern
 * terminals; native tools are tried as well for terminals that ignore it.
 */
export async function copyToClipboard(text: string, write: (s: string) => void): Promise<string> {
  write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
  const candidates: [string, string[]][] =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : process.platform === 'win32'
        ? [['clip', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ];
  for (const [cmd, args] of candidates) if (await tryCommand(cmd, args, text)) return cmd;
  return 'terminal (OSC 52)';
}
