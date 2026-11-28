const fs = require('fs'), vm = require('vm'), assert = require('assert');
const model = require('../sync-model.js');
const html = fs.readFileSync(require('path').join(__dirname, '../index.html'), 'utf8');
for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) if (!/\bsrc\s*=/.test(m[1]) && m[2].trim()) new vm.Script(m[2]);
const move = html.split("}else if(k==='move'){")[1].split("}else if(k==='momento'){")[0];
const payment = html.split("}else if(k==='owedpay'){")[1].split("}else if(k==='hmove'){")[0];
function context() {
 const S = { cc:'PEN', owed:[{id:'adrian',name:'Adrian',total:26,cc:'PEN'}], moves:[{id:'p1',type:'Ingreso',amount:10,oid:'adrian',cc:'PEN',date:'2026-11-24'},{id:'p2',type:'Ingreso',amount:10,oid:'adrian',cc:'PEN',date:'2026-11-25'},{id:'p3',type:'Ingreso',amount:6,cc:'PEN',date:'2026-11-28',w:'wallet'}], goals:[],debts:[],quicks:[] };
 const c={ S, s:{id:'p3'}, ui:{sheet:{id:'adrian'}},d:{amount:'6',date:'2026-11-28',type:'Ingreso',desc:'Cobro Adrian',cc:'PEN',wallet:'wallet'},f:{},msg:'',num:Number,t:x=>x,uid:()=> 'new-payment',toast:()=>{},save:()=>{},render:()=>{},amtErr:()=>{},savErr:()=>{},stampFx:(r,cc,p)=>{r.cc=cc||(p&&p.cc)||'PEN';},mc:x=>x.cc||'PEN',walletOf:()=>({id:'wallet',cc:'PEN',name:'Principal'}),mainWallet:()=>({id:'wallet',cc:'PEN'}),K:x=>x};
 c.oLeft=o=>Math.max(0,o.total-c.S.moves.filter(m=>m.oid===o.id&&m.type==='Ingreso').reduce((a,m)=>a+m.amount,0));return vm.createContext(c);
}
function run(c, source){vm.runInContext('(function(){'+source+'})()',c);}
// Recover an already-counted S/6 without altering any monetary field.
let c=context(), before=JSON.stringify(c.S.moves);c.s.id='adrian';c.d.existingMove='p3';run(c,payment);
assert.equal(c.oLeft(c.S.owed[0]),0);assert.equal(c.S.moves.length,3);
assert.equal(JSON.stringify(c.S.moves.map(m=>{const n={...m};delete n.oid;return n;})),JSON.stringify(JSON.parse(before).map(m=>{delete m.oid;return m;})));
run(c,payment);assert.equal(c.S.moves.length,3);assert.equal(c.oLeft(c.S.owed[0]),0);
// Editing the receipt retains its debt link.
c.s.id='p3';delete c.d.existingMove;c.d.desc='Adrian pago';run(c,move);assert.equal(c.S.moves.find(m=>m.id==='p3').oid,'adrian');assert.equal(c.oLeft(c.S.owed[0]),0);
// The same receipt survives syncing and reloading, with no extra income.
const old=context().S, baseline=model.normalize(old,'2026-11-28T10:00:00Z');const tracked=model.track(baseline,c.S,'2026-11-28T10:00:00Z','phone',1);const merged=model.merge(tracked,baseline,'2026-11-28T10:00:00Z','2026-11-28T10:00:00Z').data;c.S=JSON.parse(JSON.stringify(merged));assert.equal(c.oLeft(c.S.owed[0]),0);assert.equal(c.S.moves.reduce((a,m)=>a+m.amount,0),26);
// Reject linking a payment twice, a different currency, and overpayment.
for(const change of [m=>m.cc='USD',m=>m.amount=7,m=>m.oid='other']){c=context();change(c.S.moves[2]);c.s.id='adrian';c.d.existingMove='p3';const original=JSON.stringify(c.S);run(c,payment);assert.equal(JSON.stringify(c.S),original);}
// Reject edits that overpay or change the receipt currency.
for(const change of [d=>d.amount='7',d=>d.cc='USD']){c=context();c.S.moves[2].oid='adrian';change(c.d);if(c.d.cc==='USD')c.walletOf=()=>({id:'usd',cc:'USD'});const original=JSON.stringify(c.S);run(c,move);assert.equal(JSON.stringify(c.S),original);}
console.log('PASS: recovery without balance changes; edits preserve debt; sync/reload; duplicate/currency/overpayment guards; inline syntax.');
