import React from 'react';

const money = n => Number(n).toLocaleString('zh-CN', {maximumFractionDigits: 2});

export default function QuoteSummary({quote, onDownload, downloadStatus}) {
 const {total, range, lines, productionDays, deliveryDays, averagePerItem, selections} = quote;
 return <div className="summary pricing-summary">
  <div className="eyebrow">QUOTE / 价格与工期</div>
  <div className="pricing-total" aria-live="polite" aria-atomic="true">
   <span>预估总价</span><strong>¥{money(total)}<small> / {selections.quantity} 件</small></strong>
   <p>参考区间 ¥{money(range.low)}–{money(range.high)}</p>
  </div>
  <p className="pricing-average">平均每件 ¥{money(averagePerItem)}，含准备、包装与快递预留</p>
  <dl className="pricing-breakdown">
   {lines.map(line => <div key={line.key}>
    <dt>{line.label}<small>{line.key === 'printing' || line.key === 'packing' || line.key === 'color' ? `¥${money(line.unitPrice)} × ${line.quantity} 件` : line.basis}</small></dt>
    <dd>¥{money(line.amount)}</dd>
   </div>)}
  </dl>
  <div className="pricing-timing"><b>预计制作 {productionDays.low}–{productionDays.high} 个工作日</b><p>模型与规格确认后起算，物流参考另加 {deliveryDays.low}–{deliveryDays.high} 天。</p></div>
  <p className="pricing-caveat">内置预估，最终价格与交期由模型和实际工艺确认。</p>
  {quote.needsCustomReview && <p className="pricing-review">当前为大尺寸或多件制作，需要专项确认。</p>}
  <details className="pricing-rules"><summary>查看预估规则</summary><p>按高度、材质、对象、颜色和数量估算，未使用模型体积。参考区间为总价上下浮动 15%。适用于基础单色摆件、同一收货地址；不含复杂修复、特殊涂装、加急及偏远地区附加费。</p><p>基准：10 cm 人像、树脂、象牙白 1 件，打印 ¥77、包装 ¥5、准备 ¥29、快递预留 ¥18。准备费每单一次。</p></details>
  <button className="outline pricing-download" onClick={onDownload}>下载预估单　↓</button>
  {downloadStatus && <p className="pricing-status" role="status">{downloadStatus}</p>}
 </div>;
}
