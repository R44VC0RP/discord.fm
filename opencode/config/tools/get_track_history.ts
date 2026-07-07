import { tool } from '/opt/opencode/node_modules/@opencode-ai/plugin/dist/index.js';
import { automationTool } from '../lib/client.ts';

export default tool({
  description: 'Get bounded completed music history and server-computed next eligible times.',
  args: { limit: tool.schema.number().int().min(1).max(200).optional() },
  execute: (args, context) => automationTool('get_track_history', args, context),
});
