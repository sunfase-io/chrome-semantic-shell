/**
 * Output Limiter - 输出限长工具
 *
 * 对 JavaScript 执行结果做体积控制，保护 Agent 上下文窗口：
 * 1. 深度对象序列化（深度/数组长度/键数量/字符串长度限制）
 * 2. 输出字节数限制（默认 50KB，可通过 maxOutputBytes 调整）
 *
 * 本 fork 面向本地个人使用：不做敏感信息脱敏，数据原样返回。
 */

export const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024;

export interface OutputLimitOptions {
  maxBytes?: number;
  maxDepth?: number;
  maxArrayLength?: number;
  maxObjectKeys?: number;
  maxStringLength?: number;
}

export interface LimitedOutput {
  text: string;
  truncated: boolean;
  originalBytes: number;
}

const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_ARRAY_LENGTH = 2000;
const DEFAULT_MAX_OBJECT_KEYS = 500;

/**
 * 对任意值做深度序列化与限长处理。单个字符串的上限默认等于总字节预算，
 * 任何一级截断都会反映到 truncated，调用方据此显式提示而不是静默丢数据。
 */
export function limitOutput(value: unknown, options: OutputLimitOptions = {}): LimitedOutput {
  const maxBytes = normalizePositiveInt(options.maxBytes, DEFAULT_MAX_OUTPUT_BYTES);
  const maxDepth = normalizePositiveInt(options.maxDepth, DEFAULT_MAX_DEPTH);
  const maxArrayLength = normalizePositiveInt(options.maxArrayLength, DEFAULT_MAX_ARRAY_LENGTH);
  const maxObjectKeys = normalizePositiveInt(options.maxObjectKeys, DEFAULT_MAX_OBJECT_KEYS);
  const maxStringLength = normalizePositiveInt(options.maxStringLength, maxBytes);

  const serialized = serializeValue(value, {
    maxDepth,
    maxArrayLength,
    maxObjectKeys,
    maxStringLength,
  });

  const formatted = formatValueForOutput(serialized.value);
  const truncated = truncateTextBytes(formatted, maxBytes);

  return {
    text: truncated.text,
    truncated: serialized.truncated || truncated.truncated,
    originalBytes: truncated.originalBytes,
  };
}

function serializeValue(
  value: unknown,
  limits: {
    maxDepth: number;
    maxArrayLength: number;
    maxObjectKeys: number;
    maxStringLength: number;
  },
): { value: unknown; truncated: boolean } {
  const { maxDepth, maxArrayLength, maxObjectKeys, maxStringLength } = limits;
  const seen = new WeakMap<object, unknown>();
  let truncated = false;

  const walk = (v: unknown, depth: number): unknown => {
    if (depth < 0) {
      truncated = true;
      return '[MaxDepth]';
    }

    if (typeof v === 'string') {
      if (v.length > maxStringLength) {
        truncated = true;
        return `${v.slice(0, maxStringLength)}... [truncated ${v.length - maxStringLength} chars]`;
      }
      return v;
    }

    if (
      v === null ||
      typeof v === 'number' ||
      typeof v === 'boolean' ||
      typeof v === 'bigint' ||
      typeof v === 'undefined'
    ) {
      return v;
    }

    if (typeof v === 'symbol') return v.toString();
    if (typeof v === 'function') return `[Function${v.name ? `: ${v.name}` : ''}]`;

    if (typeof v !== 'object') return String(v);

    const obj = v as Record<string, unknown>;

    if (seen.has(obj)) return '[Circular]';

    if (Array.isArray(obj)) {
      const out: unknown[] = [];
      seen.set(obj, out);
      const len = Math.min(obj.length, maxArrayLength);
      for (let i = 0; i < len; i++) {
        out.push(walk(obj[i], depth - 1));
      }
      if (obj.length > maxArrayLength) {
        truncated = true;
        out.push('[...truncated]');
      }
      return out;
    }

    const out: Record<string, unknown> = {};
    seen.set(obj, out);

    const keys = Object.keys(obj);
    const len = Math.min(keys.length, maxObjectKeys);
    for (let i = 0; i < len; i++) {
      const key = keys[i];
      out[key] = walk(obj[key], depth - 1);
    }
    if (keys.length > maxObjectKeys) {
      truncated = true;
      out.__truncated__ = true;
    }

    return out;
  };

  const out = walk(value, maxDepth);
  return { value: out, truncated };
}

function formatValueForOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'undefined') return 'undefined';

  try {
    return safeJsonStringify(value);
  } catch {
    return String(value);
  }
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === 'bigint') return `${val.toString()}n`;
    if (typeof val === 'symbol') return val.toString();
    if (typeof val === 'function') return `[Function${val.name ? `: ${val.name}` : ''}]`;
    if (val && typeof val === 'object') {
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
    }
    return val;
  });
}

function truncateTextBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean; originalBytes: number } {
  const originalBytes = byteLength(text);
  if (originalBytes <= maxBytes) {
    return { text, truncated: false, originalBytes };
  }

  const suffix = `\n... [truncated to ${maxBytes} bytes; original ${originalBytes} bytes]`;
  const suffixBytes = byteLength(suffix);
  const budget = Math.max(0, maxBytes - suffixBytes);

  // 二分查找合适的截断点
  let lo = 0;
  let hi = text.length;

  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(0, mid);
    if (byteLength(candidate) <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  const prefix = text.slice(0, lo);
  return { text: prefix + suffix, truncated: true, originalBytes };
}

function byteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, n);
}
