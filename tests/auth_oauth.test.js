// OAuth2 client credentials mode
const fs=require('fs');const code=fs.readFileSync(process.env.COLLECTOR_CODE_FILE || require('path').join(__dirname, '..', 'src', 'collector.js'),'utf8');
let tokReq=null, bearerOK=true;
global.sha256=()=>{throw 'no crypto in oauth'};global.sign=()=>{throw 'no sign in oauth'};
global.HttpRequest=function(){this.h=[];this.st=200;};
HttpRequest.prototype.clearHeader=function(){this.h=[];};
HttpRequest.prototype.addHeader=function(x){this.h.push(x);};
HttpRequest.prototype.getStatus=function(){return this.st;};
HttpRequest.prototype.get=function(u){bearerOK=bearerOK&&this.h.includes('Authorization: Bearer TKN');return JSON.stringify({Results:[{Moid:'s1',Name:'a',Model:'UCSC-X'}]});};
HttpRequest.prototype.post=function(u,b){ if(u.endsWith('/iam/token')){tokReq=b;return JSON.stringify({access_token:'TKN',expires_in:3600});}
  bearerOK=bearerOK&&this.h.includes('Authorization: Bearer TKN');return '[]';};
const fn=new Function('value',code);
const out=JSON.parse(fn(JSON.stringify({auth:'oauth',client_id:'id 1',client_secret:'s&cr=t',api_host:'intersight.com'})));
const okTok=tokReq==='grant_type=client_credentials&client_id=id%201&client_secret=s%26cr%3Dt';
console.log((okTok?'PASS ':'FAIL ')+'OAuth2 token request body is form-encoded');
console.log((bearerOK?'PASS ':'FAIL ')+'Bearer token sent on every call');
if(!okTok||!bearerOK)process.exitCode=1;
try{fn(JSON.stringify({auth:'rsa',private_key:'-----BEGIN EC PRIVATE KEY-----\\nabc'}));console.log('FAIL EC key accepted in rsa mode');process.exitCode=1;}catch(e){console.log('PASS EC key rejected in rsa mode');}
