import { afterEach, describe, expect, it } from 'vitest';
import { detectProxyUrl, getDispatcher, resetHttpDispatcher } from '../../src/utils/http.js';

describe('detectProxyUrl', () => {
  it('返回 HTTPS_PROXY（大写）', () => {
    expect(detectProxyUrl({ HTTPS_PROXY: 'http://p1:80' })).toBe('http://p1:80');
  });

  it('小写 https_proxy 也认', () => {
    expect(detectProxyUrl({ https_proxy: 'http://p2:80' })).toBe('http://p2:80');
  });

  it('优先级：HTTPS_PROXY > https_proxy > HTTP_PROXY > http_proxy', () => {
    expect(
      detectProxyUrl({
        HTTPS_PROXY: 'http://a:1',
        https_proxy: 'http://b:1',
        HTTP_PROXY: 'http://c:1',
        http_proxy: 'http://d:1',
      }),
    ).toBe('http://a:1');
    expect(
      detectProxyUrl({
        HTTP_PROXY: 'http://c:1',
        http_proxy: 'http://d:1',
      }),
    ).toBe('http://c:1');
  });

  it('空字符串视为未设置', () => {
    expect(detectProxyUrl({ HTTPS_PROXY: '' })).toBeNull();
  });

  it('全无返回 null', () => {
    expect(detectProxyUrl({})).toBeNull();
  });
});

describe('getDispatcher', () => {
  afterEach(() => {
    resetHttpDispatcher();
  });

  it('没有代理 env 时返回 null', () => {
    expect(getDispatcher({})).toBeNull();
  });

  it('有代理 env 时返回 dispatcher 实例', () => {
    const d = getDispatcher({ HTTPS_PROXY: 'http://127.0.0.1:7890' });
    expect(d).not.toBeNull();
  });

  it('缓存命中：同一个实例', () => {
    const d1 = getDispatcher({ HTTPS_PROXY: 'http://x:1' });
    const d2 = getDispatcher({ HTTPS_PROXY: 'http://y:1' });
    expect(d1).toBe(d2); // 缓存，第二次的 env 不会被读
  });

  it('resetHttpDispatcher 后会重新读 env', () => {
    const d1 = getDispatcher({ HTTPS_PROXY: 'http://x:1' });
    resetHttpDispatcher();
    const d2 = getDispatcher({});
    expect(d2).toBeNull();
    expect(d2).not.toBe(d1);
  });
});
