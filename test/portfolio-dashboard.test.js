const test = require('node:test');
const assert = require('node:assert/strict');
const {summarize} = require('../admin/portfolio');

test('portfolio separates contractual rent from actual cash and excludes deposits and other currencies', () => {
  const data = {
    villas: [{id:'v1',name:'Villa One'},{id:'v2',name:'Villa Two'}],
    tenancies: [{id:'t1',villaId:'v1',guestName:'A',bookingStatus:'Confirmed',checkIn:'2026-09-01',checkOut:'2027-09-01',rentAmount:50000000,currency:'IDR'}],
    installments: [
      {id:'p1',villaId:'v1',tenancyId:'t1',purpose:'Rent installment',amount:100000000,currency:'IDR',status:'Paid',dueDate:'2026-09-01'},
      {id:'p2',villaId:'v1',tenancyId:'t1',purpose:'Rent installment',amount:100000000,currency:'IDR',status:'Due',dueDate:'2026-10-20'},
      {id:'deposit',villaId:'v1',tenancyId:'t1',purpose:'Security deposit',amount:10000000,currency:'IDR',status:'Paid'},
      {id:'usd',villaId:'v2',amount:1000,currency:'USD',status:'Due'}
    ],
    transactions: [{sourceId:'p1',type:'Income',amount:100000000,currency:'IDR'},{sourceId:'deposit',type:'Income',amount:10000000,currency:'IDR'}]
  };
  const result = summarize(data,'2026-10-14');
  assert.equal(result.occupied,1);
  assert.equal(result.monthly,50000000);
  assert.equal(result.contract,200000000);
  assert.equal(result.received,100000000);
  assert.equal(result.outstanding,100000000);
  assert.equal(result.upcoming,100000000);
  assert.equal(result.rows[0].remaining,100000000);
  assert.deepEqual(result.otherCurrencies,['USD']);
});

test('part payment counts as cash while only the remainder stays due', () => {
  const result = summarize({villas:[{id:'v',name:'One'}],tenancies:[{id:'t',villaId:'v',bookingStatus:'Confirmed',checkIn:'2026-10-01',checkOut:'2027-10-01',rentAmount:100,currency:'IDR'}],installments:[{id:'p',villaId:'v',tenancyId:'t',amount:100,currency:'IDR',status:'Partially paid',receivedAmount:40,remainingAmount:60,dueDate:'2026-10-10'}],transactions:[{sourceId:'receipt:p:first',type:'Income',currency:'IDR',amount:40}]},'2026-10-14');
  assert.equal(result.received,40);
  assert.equal(result.outstanding,60);
  assert.equal(result.overdue,60);
  assert.equal(result.rows[0].remaining,60);
});
