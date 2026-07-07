import { tool } from '/opt/opencode/node_modules/@opencode-ai/plugin/dist/index.js';
import { automationTool } from '../lib/client.ts';

export default tool({
  description: 'Append a bounded commentary script for ahead-of-air TTS generation; never READY immediately.',
  args: {
    script: tool.schema.string().min(1).max(2000),
    expected_queue_revision: tool.schema.number().int().nonnegative(),
    idempotency_key: tool.schema.string().min(1).max(128),
  },
  execute: (args, context) => automationTool('enqueue_commentary', args, context),
});
