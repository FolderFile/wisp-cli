import type { Feature, FeatureHost } from '../core/hooks.js';
import { createTodoTool, renderTodoWidget } from '../todo-state.js';
import { theme } from '../tui/theme.js';

/**
 * Todo list: a `todo` tool the model uses to keep a checklist for multi-step
 * work, shown as one line above the editor until everything is done. The list
 * lives in the conversation (the last successful todo call), so it is rebuilt
 * when a session loads and when /tree moves to another point.
 */
export function todoFeature(): Feature {
  let host: FeatureHost | undefined;
  let enabled = true;
  let line = '';
  const tool = createTodoTool((todos) => {
    line = renderTodoWidget(todos, { accent: theme.accent, muted: theme.muted, dim: theme.dim });
    host?.ui.render();
  });
  const rebuild = () => host && tool.reset(host.agent.messages);

  return {
    name: 'todo',
    settings: [
      {
        key: 'todo',
        label: 'Todo list',
        description: 'Let the model keep a checklist for multi-step work, shown above the input until it is done.',
        type: 'boolean',
        values: [true, false],
        default: true,
        apply: (v) => {
          enabled = v !== false;
          host?.refreshTools();
          host?.ui.render();
        },
      },
    ],
    setup(h) {
      host = h;
      enabled = h.settings.get<boolean>('todo') !== false;
    },
    tools: () => (enabled ? [tool] : []),
    widget: () => (enabled ? line : null),
    sessionLoaded: rebuild,
    branchChanged: rebuild,
  };
}
