type ToolContext = { sessionID?: string };

export async function automationTool(name: string, args: unknown, context: ToolContext): Promise<string> {
  const base = (process.env.AUTOMATION_INTERNAL_URL || 'http://automation:8092').replace(/\/$/u, '');
  const token = process.env.AUTOMATION_DJ_TOOL_TOKEN || '';
  if (!token) throw new Error('automation tool authentication is not configured');
  const response = await fetch(`${base}/internal/dj/tools/${name}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-opencode-session-id': context.sessionID || 'unknown',
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`automation ${name} rejected (${response.status}): ${body.slice(0, 1000)}`);
  return body;
}
