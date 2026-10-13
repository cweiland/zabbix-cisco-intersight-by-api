// ECDSA P-256 implementation: RFC 6979 official vector + OpenSSL verification
const crypto=require('crypto'),fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname, '..', 'src', 'collector.js'),'utf8');
const mod=src.slice(src.indexOf('// ===== BEGIN EcdsaP256'),src.indexOf('// ===== END EcdsaP256'));
// helpers used by the module
const helpers=src.slice(src.indexOf('var BASE64_ALPHABET'),src.indexOf('// Returns the value if it is a finite number'));
const E=new Function(helpers+mod+';return EcdsaP256;')();
let ok=0;for(let t=0;t<40;t++){const k=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const pem=k.privateKey.export({type:t%2?'sec1':'pkcs8',format:'pem'});const m='msg '+t;
 if(crypto.verify('sha256',Buffer.from(m),k.publicKey,Buffer.from(E.signToBase64(E.parsePrivateKey(pem),m),'base64')))ok++;}
console.log((ok===40?'PASS ':'FAIL ')+'OpenSSL verified '+ok+'/40 signatures (SEC1 and PKCS#8 keys)');if(ok!==40)process.exitCode=1;
const d=[...Buffer.from('C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721','hex')];
const h=Buffer.from(E.signToBase64(d,'sample'),'base64').toString('hex');
const vec=h.includes('efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716')&&h.includes('f7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8');
console.log((vec?'PASS ':'FAIL ')+'RFC 6979 A.2.5 test vector (P-256, SHA-256, "sample")');if(!vec)process.exitCode=1;
