# Copilot / AI coding instructions

Read `CLAUDE.md` and `AGENTS.md` first. Every change that touches student, enrolment, unit, course, location, delivery, outcome,
date or funding data must follow the "AVETMISS compliance" and "AVETMISS rules" sections of `CLAUDE.md` and the register in
`docs/compliance/AVETMISS.md`: store AVETMISS codes at entry, enforce required fields in the database, reuse the existing
avetmiss_* functions, never drop or disable an AVETMISS guard, and add a case to `supabase/tests/avetmiss_*.sql`. The
"AVETMISS compliance" GitHub workflow must pass before merging.
