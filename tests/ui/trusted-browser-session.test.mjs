import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Node's type stripper does not resolve the app's normal bundler-style import.
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "../workspace-browser-tools" && context.parentURL?.endsWith("/trusted-browser-session.ts")) {
    return next("../workspace-browser-tools.ts", context);
  }
  return next(specifier, context);
} });
const { createTrustedBrowserSession } = await import("../../apps/aerift/src/windows/trusted-browser-session.ts");
hook.deregister();
function fixture(fn, state='verified') {
  const requests=[]; const seen=[];
  const session=createTrustedBrowserSession({witness:{state,boundary:'isolated-native-host'},request:async req=>{requests.push(req);return fn(req);}},v=>seen.push(v.kind));
  return {session,requests,seen};
}
const address='https://workspace.fixture.invalid';
const visible={kind:'presented',viewport:{widthPx:640,heightPx:480},canBack:false,canForward:false};
test('fixture-only host cannot receive product chrome requests',async()=>{
 const f=fixture(()=>visible,'fixture-only');
 await f.session.command('open',address);
 assert.equal(f.session.state().kind,'external-only');
 assert.equal(f.requests.length,0);
});
test('queued or malformed replies never confirm presentation',async()=>{
 const queued=fixture(()=>({kind:'accepted'}));
 await queued.session.command('open',address);
 assert.equal(queued.session.state().kind,'pending');
 await queued.session.close();
 assert.equal(queued.session.state().kind,'closed');
 const bad=fixture(()=>({...visible,viewport:{widthPx:Infinity,heightPx:1}}));
 await bad.session.command('open',address);
 assert.equal(bad.session.state().kind,'unavailable');
 assert.deepEqual(bad.requests.map(r=>r.kind),['present','close']);
});
test('explicit controls respect resolved admission and available navigation',async()=>{
 const f=fixture(()=>visible);
 await f.session.command('open','file:///test.txt');
 assert.equal(f.requests.length,0);
 await f.session.command('open',address);
 assert.equal(f.session.state().kind,'presented');
 await f.session.command('back');
 await f.session.command('reload');
 assert.deepEqual(f.requests.map(r=>r.kind),['present','reload']);
});
test('closing rejects stale native presentation after route departure',async()=>{
 let release;
 const f=fixture(command=>command.kind==='present'?new Promise(resolve=>{release=resolve;}):{kind:'closed'});
 const opening=f.session.command('open',address);
 await f.session.close();
 release(visible);
 await opening;
 assert.equal(f.session.state().kind,'closed');
 assert(!f.seen.includes('presented'));
});
