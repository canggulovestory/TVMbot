const sheets = require('./integrations/sheets');
(async()=>{
  try {
    var d = await sheets.readSheet('1Whlirqo52ve-hMvvllRVLYaUOwAiOTXK6lgCa1xCurQ', "Transactions (Variable)!A5:AZ6");
    console.log('VAR:', JSON.stringify(d));
  } catch(e) { console.log('ERR:', e.message); }
  try {
    var d2 = await sheets.readSheet('1Whlirqo52ve-hMvvllRVLYaUOwAiOTXK6lgCa1xCurQ', "Transactions (Recurring)!A5:AZ6");
    console.log('REC:', JSON.stringify(d2));
  } catch(e) { console.log('ERR2:', e.message); }
})();
