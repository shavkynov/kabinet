'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {validAuthorizationCode}=require('../src/yandex-oauth');
const source=fs.readFileSync(path.join(__dirname,'../docs/oauth/yandex/return.js'),'utf8');
const state='a'.repeat(43);
function run(query){const message={textContent:''},button={hidden:true,addEventListener:(_e,f)=>{button.click=f;}};let assigned,cleared;const u=new URL('https://callback.example/oauth/yandex/'+query);vm.runInNewContext(source,{URL,document:{getElementById:(id)=>id==='message'?message:button},window:{location:{href:u.href,pathname:u.pathname,assign:(x)=>{assigned=x;}},history:{replaceState:(_a,_b,x)=>{cleared=x;}}}});return {message,button,cleared,assigned:()=>assigned};}
test('page and main agree on bounded opaque-code validation',()=>{
  for(const code of ['x','1234567','0123456789012345','AbCdEf0123456789','x'.repeat(2048),'','x'.repeat(2049),'bad\ncode','\0code','\x7f']){
    const x=run('?'+new URLSearchParams({code,state}));assert.equal(!x.button.hidden,validAuthorizationCode(code));
    if(!x.button.hidden){assert.equal(x.assigned(),undefined);x.button.click();assert.equal(new URL(x.assigned()).searchParams.get('code'),code);}
  }
});
test('missing or malformed state remains blocked',()=>{for(const state of ['', 'wrong'])assert.equal(run('?'+new URLSearchParams({code:'AbCdEf0123456789',state})).button.hidden,true);});
test('fragments, duplicate parameters and contradictory responses remain blocked',()=>{for(const q of ['?code=1234567&state='+state+'#access_token=secret','?code=1234567&state='+state+'&code=7654321','?code=1234567&state='+state+'&error=access_denied'])assert.equal(run(q).button.hidden,true);});
test('diagnostic output does not expose code, state or error_description',()=>{const secret='private-control\nvalue',x=run('?'+new URLSearchParams({code:secret,state,error_description:'private-description'}));assert.equal(x.message.textContent.includes(secret),false);assert.equal(x.message.textContent.includes(state),false);assert.equal(x.message.textContent.includes('private-description'),false);});
test('known error without state is explained but not forwarded',()=>{const x=run('?error=invalid_scope');assert.equal(x.button.hidden,true);assert.ok(x.message.textContent.includes('права доступа'));});
test('address bar is cleared for success and failure',()=>{for(const q of ['', '?code=AbCdEf0123456789&state='+state,'#access_token=secret'])assert.equal(run(q).cleared,'/oauth/yandex/');});
