import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateQuote, formatQuoteText } from './pricing.mjs';

const input = { heightCm: 10, material: '树脂', quantity: 1, kind: '人像', color: '象牙白' };

test('10 cm single resin reference reconciles to 129 CNY, including delivery', () => {
  const q = estimateQuote(input);
  assert.equal(q.total, 129);
  assert.deepEqual(q.range, { low: 109, high: 149 });
  assert.equal(q.lines.reduce((sum, row) => sum + row.amount, 0), q.total);
  assert.deepEqual(q.productionDays, { low: 5, high: 8 });
});

test('preparation and shipping are charged once; repeated item charges scale with quantity', () => {
  const single = estimateQuote(input), two = estimateQuote({ ...input, quantity: 2 });
  assert.equal(two.total, 211);
  for (const key of ['preparation', 'shipping']) assert.equal(two.lines.find(x => x.key === key).amount, single.lines.find(x => x.key === key).amount);
  for (const key of ['printing', 'packing', 'color']) assert.equal(two.lines.find(x => x.key === key).amount, 2 * single.lines.find(x => x.key === key).amount);
  assert.equal(two.averagePerItem, 105.5);
  const eleven = estimateQuote({ ...input, quantity: 11 });
  assert.equal(eleven.lines.find(x => x.key === 'shipping').amount, 30);
  assert.equal(eleven.needsCustomReview, true);
});

test('all displayed parameter combinations have finite consistent totals and ordered ranges', () => {
  for (const heightCm of [6, 10, 20, 21, 30]) for (const material of ['PLA', '树脂', '尼龙']) for (const quantity of [1, 2, 10, 11, 99]) {
    const q = estimateQuote({ ...input, heightCm, material, quantity });
    assert.ok(Number.isSafeInteger(q.total) && q.total > 0);
    assert.equal(q.total, q.lines.reduce((sum, x) => sum + x.unitPrice * x.quantity, 0));
    assert.ok(q.range.low <= q.total && q.range.high >= q.total);
    assert.ok(q.productionDays.low <= q.productionDays.high);
  }
  assert.ok(estimateQuote({ ...input, material: 'PLA' }).total < estimateQuote(input).total);
  assert.ok(estimateQuote({ ...input, heightCm: 30 }).total > estimateQuote({ ...input, heightCm: 6 }).total);
  assert.equal(estimateQuote({ ...input, color: '石墨灰', quantity: 3 }).lines.find(x => x.key === 'color').amount, 18);
});

test('invalid inputs cannot silently produce a plausible amount', () => {
  for (const heightCm of [0, 5.9, 30.1, NaN, Infinity, '10', null]) assert.throws(() => estimateQuote({ ...input, heightCm }));
  for (const quantity of [0, -1, 1.5, 100, NaN, '1']) assert.throws(() => estimateQuote({ ...input, quantity }));
  for (const key of ['material', 'kind', 'color']) for (const value of ['未知', 'constructor', '__proto__']) assert.throws(() => estimateQuote({ ...input, [key]: value }));
});

test('adding items never lowers the total at shipping or production batch boundaries', () => {
  for (const heightCm of [6, 10, 21, 30]) for (const material of ['PLA', '树脂', '尼龙']) {
    let previous = estimateQuote({ ...input, heightCm, material, quantity: 1 });
    for (let quantity = 2; quantity <= 99; quantity++) {
      const next = estimateQuote({ ...input, heightCm, material, quantity });
      assert.ok(next.total > previous.total, `${material}, ${heightCm} cm, ${quantity} items`);
      assert.ok(next.productionDays.low >= previous.productionDays.low);
      previous = next;
    }
  }
});

test('download reflects the selected quote and distinguishes estimate from an order', () => {
  const q = estimateQuote({ ...input, quantity: 2, color: '石墨灰' });
  const text = formatQuoteText(q, { modelName: '模型.glb', generatedAt: new Date('2026-11-13T00:00:00Z') });
  assert.match(text, /预估总价：¥223/);
  assert.match(text, /模型：模型\.glb/);
  assert.match(text, /北京时间/);
  assert.match(text, /不是订单、付款凭证或交付承诺/);
  assert.match(text, /不使用未确认单位的模型体积/);
});
