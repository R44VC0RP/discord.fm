import { tool } from '/opt/opencode/node_modules/@opencode-ai/plugin/dist/index.js';
import { automationTool } from '../lib/client.ts';

export default tool({
  description: 'Get the safe current queue projection, revision, watermarks, and commentary cadence.',
  args: {},
  execute: (args, context) => automationTool('get_queue', args, context),
});
