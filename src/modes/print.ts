import pc from 'picocolors';
import { Agent, type AgentEvent } from '../core/agent.js';
import { describeError, isAbortError } from '../core/errors.js';
import { buildUserContent } from '../core/input.js';
import type { Session } from '../core/session.js';
import { toolTitle } from '../tui/transcript.js';

/**
 * Non-interactive run. `text`: the model's answer streams to stdout and tool
 * activity goes to stderr, so output can be piped. `json`: one JSON event per
 * line on stdout (for scripts and other programs).
 */
export async function runPrint(agent: Agent, session: Session, prompt: string, cwd: string, mode: 'text' | 'json'): Promise<number> {
  const out = process.stdout;
  const err = process.stderr;
  const fancy = Boolean(err.isTTY);
  let atLineStart = true;

  agent.subscribe((e: AgentEvent) => {
    if (e.type === 'message') {
      session.log({ type: 'message', message: e.message });
      if (e.message.role === 'assistant')
        session.log({ type: 'usage', usage: agent.usage, costUSD: agent.costUSD, contextUsed: agent.contextUsed });
    }
    if (e.type === 'compaction_end') session.log({ type: 'compaction', summary: e.summary, tokensBefore: e.tokensBefore });

    if (mode === 'json') {
      const ev = e.type === 'turn_end' && e.error ? { ...e, error: describeError(e.error) } : e;
      out.write(JSON.stringify(ev) + '\n');
      return;
    }
    switch (e.type) {
      case 'text_delta':
        out.write(e.delta);
        atLineStart = e.delta.endsWith('\n');
        break;
      case 'assistant_message':
        if (!atLineStart) {
          out.write('\n');
          atLineStart = true;
        }
        if (e.stopDetail) err.write(pc.yellow(e.stopDetail) + '\n');
        break;
      case 'tool_start':
        if (fancy) err.write(pc.dim(`● ${toolTitle(e.call.name)} ${e.label.split('\n')[0].slice(0, 120)}\n`));
        break;
      case 'tool_end':
        if (e.isError && fancy) err.write(pc.red(`  ⎿  ${e.output.content.split('\n')[0].slice(0, 200)}\n`));
        break;
    }
  });

  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  try {
    const { content } = await buildUserContent(prompt, cwd, { images: agent.opts.model.images, readFiles: agent.readFiles });
    await agent.run(content, ac.signal);
    return 0;
  } catch (e) {
    if (mode === 'text') err.write(pc.red(isAbortError(e) || ac.signal.aborted ? 'Interrupted.\n' : describeError(e, { provider: agent.opts.model.provider }) + '\n'));
    return 1;
  }
}
