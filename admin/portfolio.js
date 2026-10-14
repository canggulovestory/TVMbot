/* Portfolio figures are derived from saved villa operations, never from example data. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TVMPortfolio = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const amount = value => Number(value) || 0;
  const baliToday = () => { const parts = new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Makassar',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()); const get = type => parts.find(p => p.type === type).value; return `${get('year')}-${get('month')}-${get('day')}`; };
  const days = (end, start) => Math.max(0, (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000);
  const active = (tenancy, today) => !['Cancelled', 'Enquiry', 'Checked-out'].includes(tenancy.bookingStatus) && tenancy.checkIn <= today && today < tenancy.checkOut;
  function summarize(data, today = baliToday(), currency = 'IDR') {
    const villas = data.villas || [], tenancies = data.tenancies || [], installments = data.installments || [], transactions = data.transactions || [];
    const horizon = new Date(`${today}T00:00:00Z`); horizon.setUTCDate(horizon.getUTCDate() + 30);
    const until = horizon.toISOString().slice(0, 10);
    const rows = villas.map(villa => {
      const current = tenancies.filter(t => t.villaId === villa.id && active(t, today)).sort((a, b) => b.checkIn.localeCompare(a.checkIn))[0];
      const scheduled = current ? installments.filter(p => p.villaId === villa.id && p.tenancyId === current.id && (p.currency || 'IDR') === currency && !/reservation|security deposit/i.test(p.purpose || '')) : [];
      const received = scheduled.reduce((sum, p) => sum + transactions.filter(t => (t.sourceId === p.id || String(t.sourceId || '').startsWith(`receipt:${p.id}:`)) && t.type === 'Income' && (t.currency || 'IDR') === currency).reduce((n, t) => n + amount(t.amount), 0), 0);
      const contract = scheduled.reduce((sum, p) => sum + amount(p.amount), 0);
      const unpaid = scheduled.filter(p => p.status !== 'Paid');
      const next = unpaid.filter(p => p.dueDate).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
      const overdue = unpaid.filter(p => p.dueDate && p.dueDate < today).reduce((sum, p) => sum + amount(p.remainingAmount ?? p.amount), 0);
      const duration = current ? Math.max(1, days(current.checkOut, current.checkIn) / 30.4375) : 0;
      const monthly = current && (current.currency || 'IDR') === currency ? (amount(current.rentAmount) || (contract ? contract / duration : 0)) : 0;
      return {villa, current, contract, received, remaining: Math.max(0, contract - received), overdue, monthly, next, expiring: !!current && current.checkOut <= (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 90); return d.toISOString().slice(0, 10); })()};
    });
    const eligible = installments.filter(p => (p.currency || 'IDR') === currency && !/reservation|security deposit/i.test(p.purpose || ''));
    const paidIds = new Set(eligible.map(p => p.id));
    const totalReceived = transactions.filter(t => (paidIds.has(t.sourceId) || (String(t.sourceId || '').startsWith('receipt:') && paidIds.has(String(t.sourceId).split(':')[1]))) && t.type === 'Income' && (t.currency || 'IDR') === currency).reduce((sum, t) => sum + amount(t.amount), 0);
    const unpaid = eligible.filter(p => p.status !== 'Paid');
    return {rows, villas: villas.length, occupied: rows.filter(r => r.current).length, monthly: rows.reduce((sum, r) => sum + r.monthly, 0), contract: eligible.reduce((sum, p) => sum + amount(p.amount), 0), received: totalReceived, outstanding: unpaid.reduce((sum, p) => sum + amount(p.remainingAmount ?? p.amount), 0), overdue: unpaid.filter(p => p.dueDate && p.dueDate < today).reduce((sum, p) => sum + amount(p.remainingAmount ?? p.amount), 0), upcoming: unpaid.filter(p => p.dueDate && p.dueDate >= today && p.dueDate <= until).reduce((sum, p) => sum + amount(p.remainingAmount ?? p.amount), 0), expiring: rows.filter(r => r.expiring).length, otherCurrencies: [...new Set(installments.map(p => p.currency || 'IDR').filter(c => c !== currency))]};
  }
  return {summarize,baliToday};
});
