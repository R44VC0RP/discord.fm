import { tool } from '/opt/opencode/node_modules/@opencode-ai/plugin/dist/index.js';
import { automationTool } from '../lib/client.ts';

export default tool({
  description: 'List a safe page of READY music tracks; never returns paths or private provenance.',
  args: {
    cursor: tool.schema.string().max(80).optional(),
    limit: tool.schema.number().int().min(1).max(100).optional(),
    search: tool.schema.string().max(200).optional(),
    tags: tool.schema.array(tool.schema.string().max(48)).max(20).optional(),
  },
  execute: (args, context) => automationTool('list_tracks', args, context),
});
