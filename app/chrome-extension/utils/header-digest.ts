/**
 * Header Digest - 网络抓包公共头摘要
 *
 * 抓包结果里的 commonRequestHeaders/commonResponseHeaders 每次都会原样回传
 * User-Agent、sec-ch-ua、JWT 等对 agent 无用的长字段，单次可达上千 token。
 * 这里按需压缩：丢弃纯噪音头，长值折叠为长度提示，其余原样保留。
 */

export type CommonHeadersMode = 'summary' | 'full' | 'omit';

/** 对 agent 决策无价值、且每次抓包都重复出现的头 */
const NOISE_HEADERS = new Set([
  'user-agent',
  'accept-encoding',
  'accept-language',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'upgrade-insecure-requests',
  'date',
  'vary',
  'strict-transport-security',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-allow-origin',
  'access-control-allow-credentials',
]);

/** 超过该长度的头值会被折叠（凭证类通常远超此值） */
const MAX_VALUE_CHARS = 64;
/** 折叠时保留的前缀长度，便于识别类型（如 "Bearer eyJ..."） */
const VALUE_PREFIX_CHARS = 16;

/**
 * 按模式压缩公共头。
 * - full: 原样返回
 * - omit: 返回 undefined（调用方应删除该字段）
 * - summary: 丢弃噪音头，长值折叠为 "<prefix>…(N chars)"
 */
export function digestCommonHeaders(
  headers: unknown,
  mode: CommonHeadersMode,
): Record<string, string> | undefined {
  if (mode === 'omit') return undefined;
  if (!headers || typeof headers !== 'object') return headers as undefined;
  if (mode === 'full') return headers as Record<string, string>;

  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(headers as Record<string, unknown>)) {
    if (NOISE_HEADERS.has(key.toLowerCase())) continue;

    const value = typeof rawValue === 'string' ? rawValue : String(rawValue);
    out[key] =
      value.length > MAX_VALUE_CHARS
        ? `${value.slice(0, VALUE_PREFIX_CHARS)}…(${value.length} chars)`
        : value;
  }
  return out;
}
