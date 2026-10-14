// HTTP signature rsa-sha256 (API key v2), verified with the public key
const crypto=require('crypto'), fs=require('fs');
const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const pemPkcs1=privateKey.export({type:'pkcs1',format:'pem'});
const oneLine=pemPkcs1.split('\n').filter(l=>l&&!l.startsWith('-----')).join('');
let lastSigOk=[];let pushed=null;
global.sha256=s=>crypto.createHash('sha256').update(s,'utf8').digest('hex');
global.sign=(h,k,d)=>{if(h!=='sha256')throw 'bad';return crypto.createSign('RSA-SHA256').update(d).sign(k,'hex');};
const R=(o)=>JSON.stringify(o);
global.HttpRequest=function(){this.h=[];this.st=200;};
HttpRequest.prototype.clearHeader=function(){this.h=[];};
HttpRequest.prototype.addHeader=function(x){this.h.push(x);};
HttpRequest.prototype.getStatus=function(){return this.st;};
HttpRequest.prototype._verify=function(method,url,body){
  const H={};this.h.forEach(x=>{const i=x.indexOf(': ');H[x.slice(0,i).toLowerCase()]=x.slice(i+2);});
  if(!H.authorization||!H.authorization.startsWith('Signature'))return;
  const path=url.replace('https://intersight.com','');
  const dig='SHA-256='+crypto.createHash('sha256').update(body||'').digest('base64');
  const ss=`(request-target): ${method} ${path}\ndate: ${H.date}\ndigest: ${H.digest}\nhost: ${H.host}`;
  const sig=/signature="([^"]+)"/.exec(H.authorization)[1];
  lastSigOk.push(dig===H.digest && crypto.verify('RSA-SHA256',Buffer.from(ss),publicKey,Buffer.from(sig,'base64')));
};
HttpRequest.prototype.get=function(url){this._verify('get',url,'');
  if(url.includes('PhysicalSummaries'))return R({Results:[
   {Moid:'s1',Name:'srv-a',Model:'UCSC-C220-M6S',Serial:'WZP1',Firmware:'4.2(3)',OperPowerState:'on',AlarmSummary:{Critical:1,Warning:0},ChassisId:'0'},
   {Moid:'s2',Name:'blade-1',Model:'UCSX-210C-M7',Serial:'FCH2',Firmware:'5.1',OperPowerState:'off',ChassisId:'1',RegisteredDevice:{Moid:'dom1'}},
   {Moid:'s3',Name:'srv-a',Model:'UCSC-C220-M6S',Serial:'WZP3',OperPowerState:'on'}]});
  if(url.includes('Chasses'))return R({Results:[{Moid:'c1',Name:'chassis-1',Model:'UCSX-9508',Serial:'FOX1',ChassisId:1,RegisteredDevice:{Moid:'dom1'},OperState:'operable'}]});
  if(url.includes('ElementSummaries'))return R({Results:[{Moid:'f1',Name:'FI-A',Model:'UCS-FI-6454',Version:'4.3(2)'}]});
  if(url.includes('Alarms')){ if(!url.includes("%20eq%20'None'"))throw 'enc';return R({Results:[{Severity:'Critical'},{Severity:'Warning'},{Severity:'Info'}]});}
  throw 'unexpected '+url;};
HttpRequest.prototype.post=function(url,body){
  if(url.includes('api_jsonrpc')){pushed=JSON.parse(body);return R({jsonrpc:'2.0',result:{response:'success',data:pushed.params.map((x,i)=>i==0?{error:'no item'}:{itemid:String(i)})},id:1});}
  this._verify('post',url,body);const q=JSON.parse(body);const ins=q.filter.value;
  if(ins==='hw.host')return R([{event:{'host.name':'srv-a',p_sum:3000,p_cnt:10,p_max:350}},{event:{'host.name':'FI-A',p_sum:4000,p_cnt:10,p_max:410}}]);
  if(ins==='hw.power_supply')return R([{event:{'host.name':'srv-a',name:'PSU1',u_max:41.5,o_sum:1500,o_cnt:10}},{event:{'host.name':'srv-a',name:'PSU2',u_max:38}}]);
  if(ins==='hw.network'){this.st=400;return 'bad dimension';}
  return R([]);};
const code=fs.readFileSync(process.env.COLLECTOR_CODE_FILE || require('path').join(__dirname, '..', 'src', 'collector.js'),'utf8');
const fn=new Function('value',code);
const out=JSON.parse(fn(JSON.stringify({auth:'rsa',key_id:'KID',private_key:oneLine,api_host:'intersight.com',window:'15',flat_servers:'0',zbx_url:'https://z/zabbix/api_jsonrpc.php',zbx_token:'tok'})));
console.log((lastSigOk.length && lastSigOk.every(Boolean)?'PASS ':'FAIL ')+'RSA (api key v2) signatures verified: '+lastSigOk.length);if(!(lastSigOk.length&&lastSigOk.every(Boolean)))process.exitCode=1;
console.log((pushed.params[0].host==='intersight-s1'?'PASS ':'FAIL ')+'history.push targets intersight-<Moid> hosts');
