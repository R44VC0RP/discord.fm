import { tool } from '/opt/opencode/node_modules/@opencode-ai/plugin/dist/index.js';
import { automationTool } from '../lib/client.ts';

export default tool({
  description: 'Append one atomic generated intro, eligible call, optional generated outro, and destination music group.',
  args: {
    candidate_id: tool.schema.string().regex(/^callcand_[a-z0-9_]+$/u).max(80),
    moderation_version: tool.schema.number().int().positive(),
    intro_script: tool.schema.string().min(1).max(1200),
    outro_script: tool.schema.string().max(1200).optional(),
    next_track_asset_id: tool.schema.string().regex(/^ast_[a-z0-9_]+$/u).max(80),
    expected_queue_revision: tool.schema.number().int().nonnegative(),
    idempotency_key: tool.schema.string().min(1).max(128),
    transition: tool.schema.object({
      kind: tool.schema.literal('crossfade'),
      duration_ms: tool.schema.number().int().min(500).max(10000),
    }).strict().optional(),
  },
  execute: (args, context) => automationTool('enqueue_hotline_group', args, context),
});
