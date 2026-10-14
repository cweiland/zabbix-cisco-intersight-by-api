// Scenario based on the support lists of the Intersight "Supported Metrics" pages
const crypto=require('crypto'),fs=require('fs');
const ecKey=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
global.sha256=s=>crypto.createHash('sha256').update(s,'utf8').digest('hex');
global.sign=()=>{throw 'unused'};
let verified=[],dataSources={},telemetryUrls=[],telemetryQueries=[];
global.HttpRequest=function(){this.h=[];};
HttpRequest.prototype.clearHeader=function(){this.h=[];};
HttpRequest.prototype.addHeader=function(x){this.h.push(x);};
HttpRequest.prototype.getStatus=function(){return 200;};
HttpRequest.prototype._v=function(m,u,b){const H={};this.h.forEach(x=>{const i=x.indexOf(': ');H[x.slice(0,i).toLowerCase()]=x.slice(i+2);});
  const ss=`(request-target): ${m} ${u.replace('https://intersight.com','')}\nhost: ${H.host}\ndate: ${H.date}\ndigest: ${H.digest}`;
  verified.push(crypto.verify('sha256',Buffer.from(ss),ecKey.publicKey,Buffer.from(/signature="([^"]+)"/.exec(H.authorization)[1],'base64')));};
const R=JSON.stringify;
HttpRequest.prototype.get=function(u){this._v('get',u,'');
  if(u.includes('PhysicalSummaries'))return R({Results:[
    {Moid:'s1',Name:'ucs-1',Model:'UCSC-C240-M7',Serial:'R1',OperPowerState:'on'},
    {Moid:'s2',Name:'blade-1',Model:'UCSX-210C-M7',Serial:'B1',OperPowerState:'on',ChassisId:'1',RegisteredDevice:{Moid:'d'}}]});
  if(u.includes('Chasses'))return R({Results:[{Moid:'c1',Name:'ucs-1',Model:'UCSX-9508',Serial:'C1',ChassisId:1,RegisteredDevice:{Moid:'d'}}]});
  if(u.includes('ElementSummaries'))return R({Results:[{Moid:'f1',Name:'FI-A',Model:'UCS-FI-6536'}]});
  return R({Results:[]});};
HttpRequest.prototype.post=function(u,b){
  if(u.includes('api_jsonrpc'))return R({result:{data:[]}});
  this._v('post',u,b);telemetryUrls.push(u);const q=JSON.parse(b),ins=q.filter.value;telemetryQueries.push(q);dataSources[ins]=q.dataSource;
  const ag=q.aggregations.map(a=>a.name);
  // Rows use the dimension names of the query (virtual columns host_name, host_type...).
  const row=(name,type,vals,comp,role)=>{const e={[q.dimensions[0]]:name,[q.dimensions[1]]:type};if(comp)e[q.dimensions[2]]=comp;if(role)e[q.dimensions[3]]=role;ag.forEach((n,i)=>{if(vals[i]!==undefined)e[n]=vals[i];});return {event:e};};
  if(ins==='hw.host')return R([row('ucs-1','compute.RackUnit',[4200,10,480]),row('blade-1','compute.Blade',[3500,10,400]),row('FI-A','network.Element',[5000,10,520])]); // no IMM chassis row
  if(ins==='hw.temperature')return R([row('ucs-1','compute.RackUnit',[72],'CPU1'),row('ucs-1','compute.RackUnit',[24],'Inlet'),row('ucs-1','equipment.Chassis',[30],'Inlet'),row('FI-A','network.Element',[58,75],'ASIC')]); // limit_high_critical: FI only
  if(ins==='hw.power_supply')return R([
     row('ucs-1','equipment.Chassis',[undefined,15000,10,16000,10],'PSU1'),row('ucs-1','equipment.Chassis',[undefined,14000,10,15000,10],'PSU2'), // chassis: no utilization
     row('FI-A','network.Element',[0.355,2500,10,2700,10],'PSU1')]);
  // [rx bytes, rx duration s, tx bytes, tx duration s, link speed B/s, rx errors, tx errors, util sum (0-1 ratios), util count, up min]
  if(ins==='hw.network')return R([row('FI-A','network.Element',[6e7,60,1.2e8,60,3.125e9,3,1,4.55,10,1],'Eth1/1','eth_uplink'),row('FI-A','network.Element',[undefined,undefined,undefined,undefined,undefined,undefined,undefined,1.2,10,1],'Eth1/2','server')]);
  return '[]';};
const fn=new Function('value',fs.readFileSync(process.env.COLLECTOR_CODE_FILE || require('path').join(__dirname, '..', 'src', 'collector.js'),'utf8'));
const out=JSON.parse(fn(R({key_id:'K',private_key:ecKey.privateKey.export({type:'sec1',format:'pem'}),api_host:'intersight.com',zbx_url:'https://z/api_jsonrpc.php',zbx_token:'t'})));
const by=(l,n)=>l.find(x=>x.name===n);
const rack=by(out.servers,'ucs-1'), chassis=out.chassis[0], fi=out.fis[0];
const check=(label,cond)=>{console.log((cond?'PASS ':'FAIL ')+label);if(!cond)process.exitCode=1;};
check('signatures verified '+verified.filter(Boolean).length+'/'+verified.length, verified.every(Boolean));
check('network query uses NetworkInterfaces', dataSources['hw.network']==='NetworkInterfaces');
check('other queries use PhysicalEntities', ['hw.host','hw.temperature','hw.fan','hw.power_supply'].every(i=>dataSources[i]==='PhysicalEntities'));
check('rack "ucs-1" gets its own power (420 W, host)', rack.power_w===420 && rack.power_source==='host');
check('chassis "ucs-1" power = power drawn by its PSUs (1600+1500 = 3100 W, psu_input)', chassis.power_w===3100 && chassis.power_source==='psu_input');
check('chassis does not inherit rack temperature', chassis.temp_max===30 && rack.temp_max===72);
check('FI temp margin = 75-58 = 17; rack without reported thresholds has none', fi.temp_margin_min===17 && rack.temp_margin_min===undefined);
check('PSU utilization only on FI', fi.psu_util_max===35.5 && rack.psu_util_max===undefined && chassis.psu_util_max===undefined);
check('port errors 3+1=4 on Eth1/1, none reported on Eth1/2', by(fi.ports,'Eth1/1').errors===4 && by(fi.ports,'Eth1/2').errors===undefined && fi.net_errors===4);
check('FI port utilization 45.5% and 12%', by(fi.ports,'Eth1/1').util===45.5 && by(fi.ports,'Eth1/2').util===12);
check('throughput = bytes / duration * 8: rx 6e7/60*8 = 8 Mbps, tx 16 Mbps; link 25 Gbps', by(fi.ports,'Eth1/1').rx_bps===8e6 && by(fi.ports,'Eth1/1').tx_bps===1.6e7 && by(fi.ports,'Eth1/1').speed_bps===2.5e10);
check('port role carried for the LLD filter', by(fi.ports,'Eth1/1').role==='eth_uplink' && by(fi.ports,'Eth1/2').role==='server');
const hostQuery=telemetryQueries.find(q=>q.filter.value==='hw.host'), netQuery=telemetryQueries.find(q=>q.filter.value==='hw.network');
check('dotted attributes grouped through nested-field virtual columns', JSON.stringify(hostQuery.dimensions)==='["host_name","host_type"]' && hostQuery.virtualColumns.every(v=>v.type==='nested-field') && hostQuery.virtualColumns.map(v=>v.columnName).join()==='host.name,host.type');
check('network query groups by port name and hw.network.port.role', JSON.stringify(netQuery.dimensions)==='["host_name","host_type","name","hw_network_port_role"]');
check('telemetry queries go to /api/v1/telemetry/TimeSeries', telemetryUrls.length>0 && telemetryUrls.every(u=>u.endsWith('/api/v1/telemetry/TimeSeries')));
check('no errors', out.api.errors.length===0);
