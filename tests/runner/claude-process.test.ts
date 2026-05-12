import { describe, expect, it } from 'vitest';
import { parseStreamEvent } from '../../src/runner/claude-process.js';

describe('parseStreamEvent', () => {
  it('忽略非 JSON 行', () => {
    expect(parseStreamEvent('')).toBeNull();
    expect(parseStreamEvent('   ')).toBeNull();
    expect(parseStreamEvent('not json')).toBeNull();
    expect(parseStreamEvent('[1,2]')).toBeNull(); // 不是对象起始
  });

  it('提取 message.usage', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 100,
          output_tokens: 50,
        },
      },
    });
    const r = parseStreamEvent(line);
    expect(r).toEqual({ inputTokens: 100, outputTokens: 50, costUsd: 0 });
  });

  it('提取顶层 usage 和 total_cost_usd', () => {
    const line = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 200, output_tokens: 80 },
      total_cost_usd: 0.234,
    });
    const r = parseStreamEvent(line);
    expect(r).toEqual({ inputTokens: 200, outputTokens: 80, costUsd: 0.234 });
  });

  it('找不到 usage 字段返回 null', () => {
    const line = JSON.stringify({ type: 'tool_use', name: 'Read' });
    expect(parseStreamEvent(line)).toBeNull();
  });

  it('恶心的 JSON：tokens 是字符串', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: '100', output_tokens: 50 } },
    });
    // 字符串 input_tokens 被忽略（typeof !== 'number'），但 output_tokens 仍生效
    const r = parseStreamEvent(line);
    expect(r).toEqual({ inputTokens: 0, outputTokens: 50, costUsd: 0 });
  });
});
