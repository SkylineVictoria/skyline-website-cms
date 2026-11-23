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
