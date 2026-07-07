const token = process.env.AUTOMATION_INTERNAL_TOKEN || '';
if (!token) throw new Error('AUTOMATION_INTERNAL_TOKEN is required');
const port = process.env.AUTOMATION_PORT || '8092';
const response = await fetch(`http://127.0.0.1:${port}/internal/maintenance/backup`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: '{}',
  signal: AbortSignal.timeout(120_000),
});
const output = await response.text();
process.stdout.write(`${output}\n`);
if (!response.ok) process.exitCode = 1;
