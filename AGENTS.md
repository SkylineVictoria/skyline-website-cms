# AGENTS.md

All agent instructions live in `CLAUDE.md`. Read it first and follow it exactly.
Task status: `docs/TASKS.md`. Supabase functions, migrations and env names: `docs/SUPABASE.md`.

## Permanent SLIT Business Rules policy

Every configurable SLIT policy goes in Supabase and is managed through **Administration → Business Rules & Policies**. This applies to frontend and backend code, APIs, Edge Functions, SQL, integrations and automation. Review values, required fields, dropdowns, conditions, transitions, deadlines, approvals, payments and defaults. Register each rule and its existing Admin menu, validate its schema, connect server-side enforcement, and test that publishing changes workflow behavior without a deployment. Deployment may register definitions and unapproved migration drafts. It must preserve administrator-entered versions.

Use explicitly reviewed migration continuity or a safe configuration error for missing mandatory values. Authentication, authorized actions, database integrity, infrastructure limits, protocol requirements and mandatory legal constraints stay enforced independently. Document and obtain review for exceptions. The procedure and release gates are in [the Business Rules development guide](docs/BUSINESS_RULES.md). Follow the Business Rules pull-request checklist on every feature.
