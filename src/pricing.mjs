// Product planning assumptions, not a printer's price list or a mesh-volume quote.
// All amounts are integer CNY and apply to one delivery address.
export const QUOTE_VERSION = '2026-11-demo-1';
const MATERIALS = Object.freeze({
  '树脂': { factor: 1, days: [5, 8] },
  'PLA': { factor: 0.72, days: [4, 6] },
  '尼龙': { factor: 1.55, days: [7, 10] },
});
const OBJECTS = Object.freeze({ '人像': 1, '宠物': 1, '手办': 1.08, '器物': 0.9, '建筑': 1.2, '植物': 1.1 });
const COLORS = Object.freeze({ '象牙白': 0, '石墨灰': 6, '原色': 0 });

export function estimateQuote({ heightCm, material, quantity, kind, color }) {
  if (typeof heightCm !== 'number' || !Number.isFinite(heightCm) || heightCm < 6 || heightCm > 30) {
    throw new RangeError('成品高度应在 6–30 cm 之间。');
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new RangeError('数量应为 1–99 的整数。');
  if (!Object.hasOwn(MATERIALS, material) || !Object.hasOwn(OBJECTS, kind) || !Object.hasOwn(COLORS, color)) {
    throw new TypeError('请选择支持的材质、制作对象与颜色。');
  }
  const sizeFactor = (heightCm / 10) ** 2.2;
  const printUnit = Math.round(77 * sizeFactor * MATERIALS[material].factor * OBJECTS[kind]);
  const preparation = 29;
  const packingUnit = heightCm > 20 ? 9 : 5;
  const shipping = 18 + (heightCm > 20 ? 8 : 0) + Math.floor((quantity - 1) / 10) * 12;
  const lines = [
    { key: 'preparation', label: '模型处理与制作准备', unitPrice: preparation, quantity: 1, amount: preparation, basis: '每单一次' },
    { key: 'printing', label: `${material}打印`, unitPrice: printUnit, quantity, amount: printUnit * quantity, basis: `${quantity} 件` },
    { key: 'color', label: '基础单色处理', unitPrice: COLORS[color], quantity, amount: COLORS[color] * quantity, basis: color },
    { key: 'packing', label: '包装', unitPrice: packingUnit, quantity, amount: packingUnit * quantity, basis: `${quantity} 件` },
    { key: 'shipping', label: '普通快递预留', unitPrice: shipping, quantity: 1, amount: shipping, basis: '同一收货地址' },
  ];
  const total = lines.reduce((sum, line) => sum + line.amount, 0);
  const extraDays = (heightCm > 20 ? 2 : 0) + Math.floor((quantity - 1) / 10) * 2;
  return {
    pricingVersion: QUOTE_VERSION,
    selections: { heightCm, material, quantity, kind, color },
    lines,
    total,
    averagePerItem: Math.round(total / quantity * 100) / 100,
    range: { low: Math.floor(total * 0.85), high: Math.ceil(total * 1.15) },
    productionDays: { low: MATERIALS[material].days[0] + extraDays, high: MATERIALS[material].days[1] + extraDays },
    deliveryDays: { low: 2, high: 4 },
    needsCustomReview: quantity > 10 || heightCm > 20,
  };
}

export function formatQuoteText(quote, { modelName = '', generatedAt = new Date() } = {}) {
  const s = quote.selections;
  const stamp = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(generatedAt);
  return [
    '形铸 FORM3D · 制作预估单',
    `生成时间：${stamp}（北京时间）`,
    `估算规则：${quote.pricingVersion}`,
    '',
    `制作规格：${s.kind} / 高 ${s.heightCm} cm / ${s.material} / ${s.color} / ${s.quantity} 件`,
    `模型：${modelName || '尚未导入，本单按所选规格预估'}`,
    '',
    `预估总价：¥${quote.total}`,
    `参考区间：¥${quote.range.low}–${quote.range.high}`,
    `平均每件（含分摊）：¥${quote.averagePerItem.toFixed(2)}`,
    '',
    ...quote.lines.map(line => `${line.label}：¥${line.amount}（¥${line.unitPrice} × ${line.quantity}；${line.basis}）`),
    '',
    `预计制作：${quote.productionDays.low}–${quote.productionDays.high} 个工作日，模型与规格确认后起算。`,
    `物流参考：另加 ${quote.deliveryDays.low}–${quote.deliveryDays.high} 天。`,
    '',
    '这是按高度、材质和数量等参数计算的内置预估，参考区间为总价上下浮动15%。',
    '按基础单色小型摆件、同一收货地址估算，不使用未确认单位的模型体积。',
    '不含复杂网格修复、特殊涂装、加急与偏远地区附加费。超过20cm或10件需专项确认。',
    '最终价格、可制作性及交期由项目组与打印服务商确认。此文件不是订单、付款凭证或交付承诺。',
  ].join('\r\n');
}
