USI 3PT API test
================
Needs Node 18 or newer. No npm install.

  node usi-test.js                 -> gets a MAS-ST token, then runs VerifyUSI on 6 sample records
  node usi-test.js --usi BNGH7C75FN --first Maryam --family Fredrick --dob 1966-05-25
  node usi-test.js --usi QFJEGFSBC4 --single Testsinglename --dob 1985-01-01
  node usi-test.js --dry-run       -> build signed requests without sending

Uses the kit's test credential ABRD:27809366375_USIMachine (password Password1!) and org code VA1803.
Every request/response is saved to usi-test-output\ so you can send them to IT@USI.GOV.AU if something fails.

In this repo (2026-11-23)
-------------------------
docs/usi/ holds the USI Developers Kit V5 documents and this known-good 3PT script. The keystore is NOT here: keystore*.xml is
gitignored. Put the kit keystore-usi.xml next to usi-test.js locally to run it.
The production code is supabase/functions/usi-service (Edge Function) with supabase/functions/_shared/usi/ (soap.ts = this script
ported to Deno, pkcs12.ts = keystore key decryption for Deno) and _shared/validation/usi-documents.ts. See docs/SUPABASE.md "USI".

Loading a keystore into the EF_USI_KEYSTORE_XML secret (size limit)
--------------------------------------------------------------------
Supabase secrets hold at most 24,576 characters. A keystore with several credentials (the kit file has two) is too big once
base64-encoded, so keep only the USI credential: the keystore header, that one <credential ...>...</credential> block, and the
closing tags. usi-service accepts the XML itself or base64 of it; base64 keeps it on one line for an env file.
Run in a terminal, with the keystore OUTSIDE the repo (never commit it; never paste its content anywhere):

  node -e "const fs=require('fs');const [file,id,out]=process.argv.slice(1);const x=fs.readFileSync(file,'utf8');const p=x.split('<credential ');const b=p.slice(1).find(s=>s.includes('id=\"'+id+'\"'));if(!b)throw Error('credential not found');const e=b.indexOf('</credential>')+13;const t=x.slice(x.lastIndexOf('</credential>')+13);fs.writeFileSync(out,'EF_USI_KEYSTORE_XML='+Buffer.from(p[0]+'<credential '+b.slice(0,e)+t).toString('base64')+'\n');console.log('written',out)" <keystore.xml> "<credential id, e.g. ABRD:12345678901_USIMachine>" <temp folder>\usi-keystore.env

Then add the other EF_USI_* lines to that temp file, run
  npx supabase secrets set --env-file <temp folder>\usi-keystore.env --project-ref xcpydisstlvtvcsqnjob
and delete the temp file. The 2026-11-23 3PT setup was loaded this way (one credential: 10,694 characters of XML).
For production also set EF_USI_ENVIRONMENT=production and the production STS / USI URLs (docs/SUPABASE.md "USI").
