// Scenario based on the Intersight "Supported Metrics" pages (docs/intersight_metrics.json).
// The rack plays an imm-ism-rack-mqtt server: it reports hw.cpu, fan limits and
// temperature thresholds. The FI reports limit_high_critical only.
const crypto=require('crypto'),fs=require('fs');
const ecKey=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
global.sha256=s=>crypto.createHash('sha256').update(s,'utf8').digest('hex');
global.sign=()=>{throw 'unused'};
let verified=[],ds={},cpuQueried=false;
global.HttpRequest=function(){this.h=[];};
HttpRequest.prototype.clearHeader=function(){this.h=[];};
HttpRequest.prototype.addHeader=function(x){this.h.push(x);};
HttpRequest.prototype.getStatus=function(){return 200;};
HttpRequest.prototype._v=function(m,u,b){const H={};this.h.forEach(x=>{const i=x.indexOf(': ');H[x.slice(0,i).toLowerCase()]=x.slice(i+2);});
  const ss=`(request-target): ${m} ${u.replace('https://intersight.com','')}\nhost: ${H.host}\ndate: ${H.date}\ndigest: ${H.digest}`;
  verified.push(crypto.verify('sha256',Buffer.from(ss),ecKey.publicKey,Buffer.from(/signature="([^"]+)"/.exec(H.authorization)[1],'base64')));};
const R=JSON.stringify;
HttpRequest.prototype.get=function(u){this._v('get',u,'');
  if(u.includes('PhysicalSummaries'))return R({Results:[{Moid:'s1',Name:'rack-1',Model:'UCSC-C240-M7',OperPowerState:'on'}]});
  if(u.includes('Chasses'))return R({Results:[{Moid:'c1',Name:'chassis-1',Model:'UCSX-9508',ChassisId:1}]});
  if(u.includes('ElementSummaries'))return R({Results:[{Moid:'f1',Name:'FI-A',Model:'UCS-FI-6536'}]});
  return R({Results:[]});};
HttpRequest.prototype.post=function(u,b){
  if(u.includes('api_jsonrpc'))return R({result:{data:[]}});
  this._v('post',u,b);const q=JSON.parse(b),ins=q.filter.value;ds[ins]=q.dataSource;
  const ag=q.aggregations.map(a=>a.name);
  const row=(n,t,v,c)=>{const e={[q.dimensions[0]]:n,[q.dimensions[1]]:t};if(c)e[q.dimensions[2]]=c;ag.forEach((a,i)=>{if(v[i]!==undefined)e[a]=v[i];});return {event:e};};
  const RK='compute.RackUnit',FI='network.Element';
  switch(ins){
   case 'hw.host': return R([row('rack-1',RK,[4000,10,450])]);
   case 'hw.temperature': return R([row('rack-1',RK,[83,95,80],'CPU1'),row('rack-1',RK,[25,45,40],'Inlet'),row('FI-A',FI,[60,75],'ASIC')]); // [max, critical, non-critical]
   case 'hw.fan': return R([row('rack-1',RK,[3000,9000,1800],'FAN1'),row('rack-1',RK,[1500,1700,1800],'FAN2')]); // [min, max, lower critical]
   case 'hw.memory': return R([row('rack-1',RK,[5,0],'DIMM_A1'),row('rack-1',RK,[0,0],'DIMM_B1'),row('rack-1',RK,[2,1],'DIMM_C1')]);
   case 'hw.cpu': cpuQueried=true; return R([row('rack-1',RK,[6.2,10,0.93])]); // single value across all CPUs, 0-1 ratios
   case 'system.cpu': return R([row('FI-A',FI,[7,10])]); // idle 0.7 = 70 %
   case 'system.memory': return R([row('FI-A',FI,[6.2,10])]);
   case 'hw.network': return R([row('FI-A',FI,[0,60,0,60,1.25e9,0,0,4.55,10,1],'Eth1/1'),row('FI-A',FI,[0,60,0,60,1.25e9,0,0,0,10,0],'Eth1/2')]);
   default: return '[]';}};
const fn=new Function('value',fs.readFileSync(process.env.COLLECTOR_CODE_FILE || require('path').join(__dirname, '..', 'src', 'collector.js'),'utf8'));
const out=JSON.parse(fn(R({key_id:'K',private_key:ecKey.privateKey.export({type:'sec1',format:'pem'}),api_host:'intersight.com',zbx_url:'https://z/api_jsonrpc.php',zbx_token:'t'})));
const rack=out.servers[0],fi=out.fis[0],P=n=>fi.ports.find(p=>p.name===n);
const check=(l,c)=>{console.log((c?'PASS ':'FAIL ')+l);if(!c)process.exitCode=1;};
check('signatures '+verified.filter(Boolean).length+'/'+verified.length, verified.every(Boolean));
check('13 Intersight calls (4 inventory + 9 telemetry)', out.api.calls===13);
check('hw.network -> NetworkInterfaces, others -> PhysicalEntities', ds['hw.network']==='NetworkInterfaces' && Object.entries(ds).filter(([k])=>k!=='hw.network').every(([,v])=>v==='PhysicalEntities'));
check('critical margin: rack min(95-83, 45-25) = 12, FI 75-60 = 15', rack.temp_margin_min===12 && fi.temp_margin_min===15);
check('non-critical margin: rack min(80-83, 40-25) = -3 (CPU1 above it); FI has none', rack.temp_margin_degraded_min===-3 && fi.temp_margin_degraded_min===undefined);
check('fans: lowest 1500, highest 9000 rpm, margin min(3000-1800, 1500-1800) = -300 (FAN2 too slow)', rack.fan_min===1500 && rack.fan_max===9000 && rack.fan_margin_min===-300);
check('ECC: 7 correctable, 1 uncorrectable, DIMMs "DIMM_A1, DIMM_C1"', rack.mem_ecc_correctable===7 && rack.mem_ecc_uncorrectable===1 && rack.mem_ecc_dimms==='DIMM_A1, DIMM_C1');
check('server CPU from hw.cpu: average 6.2/10 = 0.62 -> 62 %, peak 0.93 -> 93 %', cpuQueried && rack.cpu_util===62 && rack.cpu_util_max===93);
check('FI CPU = 100 - idle 70 % = 30 %, memory 0.62 -> 62 %', fi.cpu_util===30 && fi.mem_util===62);
check('port Eth1/1 util 45.5%, up; Eth1/2 down', P('Eth1/1').util===45.5 && P('Eth1/1').up===1 && P('Eth1/2').up===0);
check('chassis without telemetry has no stray fields', out.chassis[0].power_w===undefined && out.chassis[0].mem_ecc_dimms===undefined);
check('no errors', out.api.errors.length===0);
