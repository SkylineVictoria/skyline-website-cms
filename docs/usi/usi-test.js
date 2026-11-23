#!/usr/bin/env node
/*
 * USI Web Services v5 – third-party test (3PT) smoke test.
 * Zero dependencies: needs only Node 18+.
 *
 *   node usi-test.js                      # get a token, then verify all sample USIs
 *   node usi-test.js --usi BNGH7C75FN --first Maryam --family Fredrick --dob 1966-05-25
 *   node usi-test.js --dry-run            # build + print requests without sending
 *
 * Flow:
 *   1. Decrypt the M2M credential from keystore-usi.xml (ABR credential store).
 *   2. Send a WS-Trust Issue request to MAS-ST (S007v1.3), signed with RSA-SHA256.
 *   3. Take the encrypted SAML token + symmetric proof key from the response.
 *   4. Call USI VerifyUSI, signing the WS-Security timestamp with HMAC-SHA1.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- config (from the USI developer kit, RTO self-authentication model) ----------
const CFG = {
  keystore: path.join(__dirname, 'keystore-usi.xml'),
  credentialId: 'ABRD:27809366375_USIMachine',
  password: 'Password1!',
  orgCode: 'VA1803',
  stsUrl: process.env.USI_STS_URL || 'https://softwareauthorisations.evte.ato.gov.au/R3.0/S007v1.3/service.svc',
  usiUrl: 'https://3pt.portal.usi.gov.au/service/v5/usiservice.svc',
  actionBase: 'http://usi.gov.au/2022/ws/',
};

const SAMPLES = [
  { usi: 'BNGH7C75FN', first: 'Maryam', family: 'Fredrick', dob: '1966-05-25', expect: 'Valid (Active)' },
  { usi: 'BP6LKB3C7X', first: 'Csenge', family: 'Gumarsson', dob: '1988-12-26', expect: 'Valid (Active)' },
  { usi: 'RVJ5DM8LXJ', first: 'Kim', family: 'Juras', dob: '1966-08-02', expect: 'Suspended' },
  { usi: 'DG6K5YHPP3', first: 'Asfaha', family: 'Loflin', dob: '1982-12-23', expect: 'Deactivated' },
  { usi: 'QFJEGFSBC4', single: 'Testsinglename', dob: '1985-01-01', expect: 'Single name' },
  { usi: 'BNGH7C75FN', first: 'Maryam', family: 'Wrongname', dob: '1966-05-25', expect: 'Name mismatch' },
];

// ---------- namespaces ----------
const NS = {
  s: 'http://www.w3.org/2003/05/soap-envelope',
  a: 'http://www.w3.org/2005/08/addressing',
  u: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  o: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  ds: 'http://www.w3.org/2000/09/xmldsig#',
  trust: 'http://docs.oasis-open.org/ws-sx/ws-trust/200512',
  wsp: 'http://schemas.xmlsoap.org/ws/2004/09/policy',
  wsid: 'http://schemas.xmlsoap.org/ws/2005/05/identity',
};
const C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const X509 = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3';
const B64 = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';

// ---------- helpers ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const b64 = (buf) => Buffer.from(buf).toString('base64');
const uuid = () => 'urn:uuid:' + crypto.randomUUID();
const isoNow = (offsetMin = 0) => new Date(Date.now() + offsetMin * 60000).toISOString();

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

// ---------- credential ----------
function loadCredential(file, id, password) {
  const xml = fs.readFileSync(file, 'utf8');
  const blocks = xml.split('<credential ').slice(1);
  const block = blocks.find((b) => b.includes(`id="${id}"`));
  if (!block) throw new Error(`Credential ${id} not found in ${file}`);
  const tag = (t) => (block.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1];
  const key = crypto.createPrivateKey({
    key: Buffer.from(tag('protectedPrivateKey').replace(/\s/g, ''), 'base64'),
    format: 'der', type: 'pkcs8', passphrase: password,
  });
  // publicCertificate is a PKCS#7 bundle; pull out each embedded X.509 cert and pick the one matching the key.
  const p7 = Buffer.from(tag('publicCertificate').replace(/\s/g, ''), 'base64');
  const pub = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  for (let i = 0; i < p7.length - 8; i++) {
    if (p7[i] === 0x30 && p7[i + 1] === 0x82 && p7[i + 4] === 0x30 && p7[i + 5] === 0x82) {
      const len = (p7[i + 2] << 8) + p7[i + 3] + 4;
      try {
        const der = p7.subarray(i, i + len);
        const cert = new crypto.X509Certificate(der);
        if (cert.publicKey.export({ type: 'spki', format: 'der' }).equals(pub)) return { key, certDer: der, cert };
      } catch { /* not a cert at this offset */ }
    }
  }
  throw new Error('Could not find certificate matching the private key');
}

// ---------- XML signing ----------
// Elements are written directly in exclusive-c14n form (no whitespace, namespace decls first,
// explicit end tags), so the bytes we hash are the bytes we send.
function timestampXml(id, created, expires) {
  return `<u:Timestamp xmlns:u="${NS.u}" u:Id="${id}"><u:Created>${created}</u:Created><u:Expires>${expires}</u:Expires></u:Timestamp>`;
}
function signedInfoXml(sigAlg, digestAlg, refId, digest) {
  return `<SignedInfo xmlns="${NS.ds}"><CanonicalizationMethod Algorithm="${C14N}"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="${sigAlg}"></SignatureMethod><Reference URI="#${refId}"><Transforms>` +
    `<Transform Algorithm="${C14N}"></Transform></Transforms><DigestMethod Algorithm="${digestAlg}"></DigestMethod>` +
    `<DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;
}

// ---------- 1. MAS-ST request ----------
function buildStsRequest(cred, appliesTo) {
  const tsId = '_0', bstId = 'uuid-' + crypto.randomUUID() + '-1';
  const created = isoNow(), expires = isoNow(5);
  const ts = timestampXml(tsId, created, expires);
  const digest = b64(crypto.createHash('sha256').update(ts).digest());
  const si = signedInfoXml('http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', 'http://www.w3.org/2001/04/xmlenc#sha256', tsId, digest);
  const sigVal = b64(crypto.sign('sha256', Buffer.from(si), cred.key));

  return `<s:Envelope xmlns:s="${NS.s}" xmlns:a="${NS.a}" xmlns:u="${NS.u}"><s:Header>` +
    `<a:Action s:mustUnderstand="1">http://docs.oasis-open.org/ws-sx/ws-trust/200512/RST/Issue</a:Action>` +
    `<a:MessageID>${uuid()}</a:MessageID>` +
    `<a:ReplyTo><a:Address>http://www.w3.org/2005/08/addressing/anonymous</a:Address></a:ReplyTo>` +
    `<a:To s:mustUnderstand="1">${CFG.stsUrl}</a:To>` +
    `<o:Security s:mustUnderstand="1" xmlns:o="${NS.o}">${ts}` +
    `<o:BinarySecurityToken u:Id="${bstId}" ValueType="${X509}" EncodingType="${B64}">${b64(cred.certDer)}</o:BinarySecurityToken>` +
    `<Signature xmlns="${NS.ds}">${si}<SignatureValue>${sigVal}</SignatureValue>` +
    `<KeyInfo><o:SecurityTokenReference><o:Reference URI="#${bstId}" ValueType="${X509}"/></o:SecurityTokenReference></KeyInfo></Signature>` +
    `</o:Security></s:Header><s:Body>` +
    `<trust:RequestSecurityToken xmlns:trust="${NS.trust}">` +
    `<wsp:AppliesTo xmlns:wsp="${NS.wsp}"><a:EndpointReference><a:Address>${appliesTo}</a:Address></a:EndpointReference></wsp:AppliesTo>` +
    `<trust:Claims Dialect="${NS.wsid}" xmlns:wsid="${NS.wsid}">` +
    `<wsid:ClaimType Uri="http://vanguard.ebusiness.gov.au/2008/06/identity/claims/abn"/>` +
    `<wsid:ClaimType Uri="http://vanguard.ebusiness.gov.au/2008/06/identity/claims/credentialtype"/>` +
    `</trust:Claims>` +
    `<trust:KeyType>http://docs.oasis-open.org/ws-sx/ws-trust/200512/SymmetricKey</trust:KeyType>` +
    `<trust:Lifetime><u:Created>${created}</u:Created><u:Expires>${isoNow(30)}</u:Expires></trust:Lifetime>` +
    `<trust:RequestType>http://docs.oasis-open.org/ws-sx/ws-trust/200512/Issue</trust:RequestType>` +
    `<trust:TokenType>http://docs.oasis-open.org/wss/oasis-wss-saml-token-profile-1.1#SAMLV2.0</trust:TokenType>` +
    `<trust:KeySize>256</trust:KeySize>` +
    `<trust:KeyWrapAlgorithm>http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p</trust:KeyWrapAlgorithm>` +
    `<trust:EncryptWith>http://www.w3.org/2001/04/xmlenc#aes256-cbc</trust:EncryptWith>` +
    `<trust:SignWith>http://www.w3.org/2000/09/xmldsig#hmac-sha1</trust:SignWith>` +
    `<trust:CanonicalizationAlgorithm>${C14N}</trust:CanonicalizationAlgorithm>` +
    `<trust:EncryptionAlgorithm>http://www.w3.org/2001/04/xmlenc#aes256-cbc</trust:EncryptionAlgorithm>` +
    `</trust:RequestSecurityToken></s:Body></s:Envelope>`;
}

// ---------- 2. parse the RSTR ----------
// Pull an element out of the response as raw text, adding any namespace declarations it relies on
// from ancestors so it stays valid when pasted into a new message.
// Find an element by local name (searching from `from`) and return its raw text plus its end index.
function findElement(xml, localName, from = 0) {
  const open = new RegExp(`<([\\w.-]+:)?${localName}(?=[\\s>/])`, 'g');
  open.lastIndex = from;
  const m = open.exec(xml);
  if (!m) return null;
  const qname = (m[1] || '') + localName;
  const re = new RegExp(`<(/?)${qname.replace(/\./g, '\\.')}(?=[\\s>/])[^>]*?(/?)>`, 'g');
  re.lastIndex = m.index;
  let depth = 0, t;
  while ((t = re.exec(xml))) {
    if (t[1]) depth--; else if (!t[2]) depth++;
    if (depth === 0) return { start: m.index, end: re.lastIndex, raw: xml.slice(m.index, re.lastIndex) };
  }
  return null;
}
// Add namespace declarations an extracted element relies on (declared on ancestors in `doc`).
function withAncestorNs(doc, el) {
  const decls = {};
  for (const d of doc.matchAll(/xmlns:([\w.-]+)="([^"]*)"/g)) decls[d[1]] ??= d[2];
  const used = new Set([...el.matchAll(/<\/?([\w.-]+):/g), ...el.matchAll(/\s([\w.-]+):[\w.-]+=/g)]
    .map((x) => x[1]).filter((p) => p !== 'xmlns' && p !== 'xml'));
  const missing = [...used].filter((p) => decls[p] && !el.includes(`xmlns:${p}="`));
  return missing.length ? el.replace(/^<[\w.:-]+/, (s) => s + missing.map((p) => ` xmlns:${p}="${decls[p]}"`).join('')) : el;
}
const extractElement = (xml, name, from = 0) => { const e = findElement(xml, name, from); return e ? withAncestorNs(xml, e.raw) : null; };
const innerOf = (el) => el.replace(/^<[^>]*>/, '').replace(/<\/[^>]*>$/, '');
const textOf = (xml, name) => { const e = findElement(xml, name); return e ? innerOf(e.raw).trim() : null; };

function parseRstr(xml) {
  if (/:Fault[\s>]/.test(xml)) {
    throw new Error('MAS-ST fault: ' + (textOf(xml, 'Text') || textOf(xml, 'faultstring') || 'unknown') +
      (textOf(xml, 'Subcode') ? ` [${textOf(xml, 'Subcode').replace(/<[^>]+>/g, '').trim()}]` : ''));
  }
  const rst = findElement(xml, 'RequestedSecurityToken');
  if (!rst) throw new Error('No RequestedSecurityToken in MAS-ST response');
  // The token is the first child element (EncryptedAssertion / EncryptedData / Assertion) – copied verbatim.
  const openEnd = xml.indexOf('>', rst.start) + 1;
  const childLocal = xml.slice(openEnd).match(/^\s*<(?:[\w.-]+:)?([\w.-]+)/)[1];
  const token = extractElement(xml, childLocal, openEnd);
  const proof = findElement(xml, 'RequestedProofToken');
  const secret = proof && textOf(proof.raw, 'BinarySecret');
  if (!secret) throw new Error('No BinarySecret proof key returned (MAS-ST may have expected entropy)');
  const att = findElement(xml, 'RequestedAttachedReference');
  const str = att && extractElement(xml, 'SecurityTokenReference', att.start);
  if (!str) throw new Error('No RequestedAttachedReference/SecurityTokenReference in response');
  const life = findElement(xml, 'Lifetime');
  return { token, key: Buffer.from(secret, 'base64'), str, expires: life && textOf(life.raw, 'Expires') };
}

// ---------- 3. USI request ----------
function buildUsiRequest(op, bodyXml, tok) {
  const tsId = '_0';
  const ts = timestampXml(tsId, isoNow(), isoNow(5));
  const digest = b64(crypto.createHash('sha1').update(ts).digest());
  const si = signedInfoXml('http://www.w3.org/2000/09/xmldsig#hmac-sha1', 'http://www.w3.org/2000/09/xmldsig#sha1', tsId, digest);
  const sigVal = b64(crypto.createHmac('sha1', tok.key).update(si).digest());
  return `<s:Envelope xmlns:s="${NS.s}" xmlns:a="${NS.a}" xmlns:u="${NS.u}"><s:Header>` +
    `<a:Action s:mustUnderstand="1">${CFG.actionBase}${op}</a:Action>` +
    `<a:MessageID>${uuid()}</a:MessageID>` +
    `<a:ReplyTo><a:Address>http://www.w3.org/2005/08/addressing/anonymous</a:Address></a:ReplyTo>` +
    `<a:To s:mustUnderstand="1">${CFG.usiUrl}</a:To>` +
    `<o:Security s:mustUnderstand="1" xmlns:o="${NS.o}">${ts}${tok.token}` +
    `<Signature xmlns="${NS.ds}">${si}<SignatureValue>${sigVal}</SignatureValue><KeyInfo>${tok.str}</KeyInfo></Signature>` +
    `</o:Security></s:Header><s:Body>${bodyXml}</s:Body></s:Envelope>`;
}
function verifyBody(r) {
  const names = r.single ? `<SingleName>${esc(r.single)}</SingleName>`
    : `<FirstName>${esc(r.first)}</FirstName><FamilyName>${esc(r.family)}</FamilyName>`;
  return `<VerifyUSI xmlns="http://usi.gov.au/2022/ws"><OrgCode>${esc(CFG.orgCode)}</OrgCode>` +
    `<USI>${esc(r.usi)}</USI>${names}<DateOfBirth>${esc(r.dob)}</DateOfBirth></VerifyUSI>`;
}

// ---------- HTTP ----------
async function post(url, xml, action) {
  const target = url === CFG.usiUrl && process.env.USI_POST_URL ? process.env.USI_POST_URL : url;
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': `application/soap+xml; charset=utf-8; action="${action}"` },
    body: xml,
  });
  return { status: res.status, text: await res.text() };
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dry = !!args['dry-run'];
  const outDir = path.join(__dirname, 'usi-test-output');
  fs.mkdirSync(outDir, { recursive: true });
  const save = (name, data) => fs.writeFileSync(path.join(outDir, name), data);

  const cred = loadCredential(args.keystore || CFG.keystore, CFG.credentialId, CFG.password);
  console.log(`Credential: ${cred.cert.subject.replace(/\n/g, ', ')}  (valid to ${cred.cert.validTo})`);

  // 1. token
  const stsReq = buildStsRequest(cred, CFG.usiUrl);
  save('1-mas-st-request.xml', stsReq);
  if (dry) {
    const fakeKey = crypto.randomBytes(32);
    const fake = { token: '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_dry"/>', key: fakeKey,
      str: `<o:SecurityTokenReference xmlns:o="${NS.o}"><o:KeyIdentifier ValueType="http://docs.oasis-open.org/wss/oasis-wss-saml-token-profile-1.1#SAMLID">_dry</o:KeyIdentifier></o:SecurityTokenReference>` };
    save('dry-run-key.txt', b64(fakeKey));
    save('2-usi-request.xml', buildUsiRequest('VerifyUSI', verifyBody(SAMPLES[0]), fake));
    console.log(`Dry run: requests written to ${outDir}`);
    return;
  }
  console.log(`\n[1] Requesting SAML token from MAS-ST…`);
  const sts = await post(CFG.stsUrl, stsReq, 'http://docs.oasis-open.org/ws-sx/ws-trust/200512/RST/Issue');
  save('1-mas-st-response.xml', sts.text);
  console.log(`    HTTP ${sts.status}`);
  const tok = parseRstr(sts.text);
  console.log(`    OK – token received, proof key ${tok.key.length * 8}-bit${tok.expires ? ', expires ' + tok.expires : ''}`);

  // 2. verify USIs
  const records = args.usi
    ? [{ usi: args.usi, first: args.first, family: args.family, single: args.single, dob: args.dob, expect: '(custom)' }]
    : SAMPLES;
  console.log(`\n[2] VerifyUSI against ${CFG.usiUrl} (org ${CFG.orgCode})`);
  let n = 0;
  for (const r of records) {
    n++;
    const req = buildUsiRequest('VerifyUSI', verifyBody(r), tok);
    save(`2-verify-${n}-request.xml`, req);
    const res = await post(CFG.usiUrl, req, CFG.actionBase + 'VerifyUSI');
    save(`2-verify-${n}-response.xml`, res.text);
    const who = r.single || `${r.first} ${r.family}`;
    if (res.status !== 200) {
      console.log(`  ✗ ${r.usi} ${who}: HTTP ${res.status} – ${(textOf(res.text, 'Text') || res.text.slice(0, 300)).replace(/<[^>]+>/g, '')}`);
      continue;
    }
    const field = (f) => textOf(res.text, f) || '-';
    console.log(`  ✓ ${r.usi} ${who.padEnd(22)} USIStatus=${field('USIStatus').padEnd(12)} ` +
      `First=${field('FirstName')} Family=${field('FamilyName')} Single=${field('SingleName')} DOB=${field('DateOfBirth')}  [expected: ${r.expect}]`);
  }
  console.log(`\nRaw requests/responses saved in ${outDir}`);
}

main().catch((e) => { console.error('\nERROR:', e.message); process.exitCode = 1; });
