import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { TARGETS, inspectPrivateReports } from "./worker.mjs";
const NOW = Date.parse("2026-11-22T06:15:00.000Z");
const base = {
  "f402-bet-ticker/latest.json": { data_window_max_epoch_ms: NOW - 10 * 60_000, rowCount: 236 },
  "gslive-tally/latest.json": { generatedAt: new Date(NOW - 14 * 86400000).toISOString(), key: "gslive-tally/2026-11-08/rollup.json" },
  "gslive-tally/2026-11-08/rollup.json": { rowCount: 0, tickets: [{login:"PRIVATE_DO_NOT_LOG"}] },
  "f402-weblog/latest.json": { data_window_max_epoch_ms: NOW - 5 * 60_000, coverage: { wholeBookComplete: false, scope:"live-pending-accounts", requestedAccounts:18, completedAccounts:18, unidentifiedTicketRows:93, names:["PRIVATE_DO_NOT_LOG"] } },
  "wagers-by-state/latest.json": { capturedAt: new Date(NOW - 13 * 86400000).toISOString(), generatedAt:new Date(NOW).toISOString(), staleness:{stale:true}, states:[{login:"PRIVATE_DO_NOT_LOG"}] },
};
const store=(values=base)=>({async get(key){return key in values ? {size:JSON.stringify(values[key]).length,text:async()=>JSON.stringify(values[key])} : null;}});
test("four fixed data targets, no arbitrary key reads",()=>assert.deepEqual(TARGETS.map(x=>x.id),["ticker","gslive","weblog","wagers"]));
test("true source age, not recent publish, determines stale",async()=>{
 const r=await inspectPrivateReports(store(), NOW);
 assert.deepEqual(r.checks.map(x=>x.status),["fresh","stale","partial","stale"]);
 assert.equal(r.degradedCount,2);
 assert.equal(r.partialCount,1);
 assert.ok(r.checks[3].ageMinutes > 18000);
 assert.ok(!JSON.stringify(r).includes("PRIVATE_DO_NOT_LOG"));
});
test("missing versus R2 read error are distinct",async()=>{
 const missing=await inspectPrivateReports(store({}),NOW);
 assert.ok(missing.checks.every(x=>x.status==="missing"));
 const fail=await inspectPrivateReports({get:async()=>{throw new Error("Bearer PRIVATE_DO_NOT_LOG")}},NOW);
 assert.ok(fail.checks.every(x=>x.status==="unverified"));
 assert.ok(!JSON.stringify(fail).includes("PRIVATE_DO_NOT_LOG"));
});
test("bad timestamp and forged future timestamp cannot be called fresh",async()=>{
 const v={...base,"f402-bet-ticker/latest.json":{data_window_max_epoch_ms:NOW+3600000}};
 const r=await inspectPrivateReports(store(v),NOW);
 assert.equal(r.checks[0].status,"invalid");
});
test("gslive must resolve bounded archive with valid nonnegative rowCount",async()=>{
 const v={...base,"gslive-tally/2026-11-08/rollup.json":{rowCount:-1}};
 assert.equal((await inspectPrivateReports(store(v),NOW)).checks[1].status,"invalid");
 const v2={...base,"gslive-tally/latest.json":{generatedAt:new Date(NOW).toISOString(),key:"gslive-tally/2026-11-08/rollup.json"}};
 assert.equal((await inspectPrivateReports(store(v2),NOW)).checks[1].status,"empty");
});
test("does not follow malicious pointer keys",async()=>{
 const v={...base,"gslive-tally/latest.json":{generatedAt:new Date(NOW).toISOString(),key:"../secret"}};
 const reads=[];
 const bucket={async get(key){reads.push(key);return store(v).get(key);}};
 const r=await inspectPrivateReports(bucket,NOW);
 assert.equal(r.checks[1].status,"invalid");
 assert.ok(!reads.includes("../secret"));
});
test("http route fails closed and scheduled invocation awaits private reads",async()=>{
 assert.equal((await worker.fetch()).status,404);
 const invoked=[];
 const savedLog=console.log, savedErr=console.error, savedWarn=console.warn;
 const logs=[];
 console.log=(s)=>logs.push(s);
 console.error=(s)=>logs.push(s);
 console.warn=(s)=>logs.push(s);
 try{
  await worker.scheduled({}, {REPORTS:store()}, {waitUntil:(promise)=>invoked.push(promise)});
  assert.equal(invoked.length,1);
  await Promise.all(invoked);
  assert.ok(logs.some(s=>s.includes("sportsdesk_r2_source_freshness")));
  assert.ok(!logs.join("\n").includes("PRIVATE_DO_NOT_LOG"));
 }finally{console.log=savedLog;console.error=savedErr;console.warn=savedWarn;}
});
