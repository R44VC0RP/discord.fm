import { tool } from '/opt/opencode/node_modules/@opencode-ai/plugin/dist/index.js';
import { automationTool } from '../lib/client.ts';

export default tool({
  description: 'Append one immutable READY music asset with the fixed bounded crossfade policy.',
  args: {
    asset_id: tool.schema.string().regex(/^ast_[a-z0-9_]+$/u).max(80),
    expected_queue_revision: tool.schema.number().int().nonnegative(),
    idempotency_key: tool.schema.string().min(1).max(128),
    transition: tool.schema.object({
      kind: tool.schema.literal('crossfade'),
      duration_ms: tool.schema.number().int().min(500).max(5000),
    }).strict().optional(),
  },
  execute: (args, context) => automationTool('enqueue_track', args, context),
});
