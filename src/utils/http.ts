import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ mod: 'http' });

/**
 * 从 env 读 HTTPS_PROXY / HTTP_PROXY（含小写变体），返回首个非空 URL；都没有则返回 null。
 */
export function detectProxyUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
  for (const k of keys) {
    const v = env[k];
    if (v && v.length > 0) return v;
  }
  return null;
}

/**
 * 全局 dispatcher 缓存。第一次按 env 配好，后续命中即返回。
 * 测试可通过 resetHttpDispatcher() 重置。
 */
let cachedDispatcher: Dispatcher | null | undefined;

export function getDispatcher(env: NodeJS.ProcessEnv = process.env): Dispatcher | null {
  if (cachedDispatcher !== undefined) return cachedDispatcher;
  const proxyUrl = detectProxyUrl(env);
  if (!proxyUrl) {
    cachedDispatcher = null;
    return null;
  }
  log.debug({ proxyUrl }, 'using HTTP(S) proxy from environment');
  cachedDispatcher = new ProxyAgent(proxyUrl);
  return cachedDispatcher;
}

export function resetHttpDispatcher(): void {
  cachedDispatcher = undefined;
}

/**
 * fetch 包装。Node 20+ 的全局 fetch 不会读 HTTPS_PROXY；这里用 undici 的 fetch
 * 显式注入 ProxyAgent（如果 env 里配了代理）。
 *
 * 行为和 global fetch 一致，签名兼容；不传 dispatcher 也能用。
 */
export const proxiedFetch: typeof fetch = ((
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => {
  const dispatcher = getDispatcher();
  // undici 的 fetch 接受 dispatcher 字段，类型上 RequestInit 没有，所以 cast。
  const initWithDispatcher = dispatcher ? { ...init, dispatcher } : init;
  return undiciFetch(input as never, initWithDispatcher as never) as unknown as ReturnType<
    typeof fetch
  >;
}) as typeof fetch;
