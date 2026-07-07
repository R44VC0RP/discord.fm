import crypto from 'node:crypto';
import { DomainError, invariant } from './errors.js';

const FORBIDDEN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const ID = /^[a-z][a-z0-9_]{2,79}$/;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function exactObject(value: unknown, allowed: readonly string[], label = 'body'): Record<string, unknown> {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_BODY', `${label} must be an object`);
  const object = value as Record<string, unknown>;
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new DomainError('UNKNOWN_FIELDS', `${label} contains unknown fields`, 400, { fields: unknown });
  return object;
}

export function text(value: unknown, field: string, max: number, required = true): string | null {
  if ((value === undefined || value === null || value === '') && !required) return null;
  invariant(typeof value === 'string', 'INVALID_TEXT', `${field} must be a string`);
  const normalized = value.normalize('NFC').trim();
  invariant(!required || normalized.length > 0, 'INVALID_TEXT', `${field} is required`);
  invariant(Buffer.byteLength(normalized, 'utf8') <= max, 'TEXT_TOO_LONG', `${field} exceeds ${max} bytes`);
  invariant(!FORBIDDEN_TEXT.test(normalized), 'INVALID_TEXT', `${field} contains forbidden control or bidi characters`);
  return normalized;
}

export function id(value: unknown, field: string): string {
  const result = text(value, field, 80) as string;
  invariant(ID.test(result), 'INVALID_ID', `${field} is malformed`);
  return result;
}

export function idempotencyKey(value: unknown): string {
  const result = text(value, 'idempotency_key', 128) as string;
  invariant(IDEMPOTENCY.test(result), 'INVALID_IDEMPOTENCY_KEY', 'idempotency_key is malformed');
  return result;
}

export function referenceId(value: unknown, field: string): string {
  const result = text(value, field, 128) as string;
  invariant(IDEMPOTENCY.test(result), 'INVALID_ID', `${field} is malformed`);
  return result;
}

export function integer(value: unknown, field: string, min: number, max: number): number {
  invariant(Number.isInteger(value) && Number(value) >= min && Number(value) <= max, 'INVALID_NUMBER', `${field} must be an integer from ${min} to ${max}`);
  return Number(value);
}

export function optionalIso(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const raw = text(value, field, 40) as string;
  const parsed = new Date(raw);
  invariant(Number.isFinite(parsed.getTime()), 'INVALID_TIMESTAMP', `${field} must be an ISO timestamp`);
  return parsed.toISOString();
}

export function tags(value: unknown): string[] {
  if (value === undefined) return [];
  invariant(Array.isArray(value) && value.length <= 20, 'INVALID_TAGS', 'tags must contain at most 20 strings');
  const clean = value.map((tag, index) => (text(tag, `tags[${index}]`, 48) as string).toLocaleLowerCase('en-US'));
  return [...new Set(clean)];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

export function requestHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function stableId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function now(): string {
  return new Date().toISOString();
}
