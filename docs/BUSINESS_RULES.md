# SLIT Business Rules & Policies

## Adding a policy

1. Identify the existing Admin menu ID. Use the database Admin menu registry or the LMS and Email Management navigation exports for screens already defined there. Keep stable menu IDs when renaming labels.
2. Give the rule a stable identifier. Register its menu, entity, schema version and validation in a forward migration using `public.business_rule_register`. Create a complete, attributed draft when migrating an existing value. New features that need an essential value must remain inactive until SLIT publishes it. Preserve administrator versions and categories on redeployment. A schema change requires an explicit forward migration.
3. Register only the fields a workflow can supply, including typed relationship values resolved by trusted backend code. Definitions contain data only. Provide a fixed server action handler for the supported operation and validate its inputs and any external constraints.
4. Call `public.business_rule_evaluate` from the authorized database command, trigger, or server-side adapter. Authorization must be checked independently. The caller supplies the verified organization scope, stable identifier and real context. Use the same rule for frontend feedback. A configurable rule must have an enforcement point to affect a workflow.
5. Add the identifier, menu, implementation, and test to `scripts/business-rules-registry.json`. Test authorization, draft isolation, publication, effective dates, new values changing real workflow behavior, history, and repeated registration. Complete the pull request checklist.
6. Document continuity explicitly during migration. Where missing values would invalidate a workflow, fail with an actionable configuration error. Keep mandatory legal, security, and integrity controls independent. Validate any SLIT policy against mandatory external bounds and retain the cited source and effective dates.

## Review and release

The CI job `Registry and enforcement` validates registration wiring, scans added lines for likely policies, and runs the isolated PostgreSQL workflow tests. GitHub must require this job and approving code review on `main`. Give the release identity only the access it needs, and gate any manual production deployment on the same checks. A repository workflow alone cannot enforce a branch rule. Confirm the actual ruleset before treating this as a production gate.

For flags, register and wire the business rule, or annotate the candidate with `rule-policy: technical|security|regulatory <classification-id> <reason>` and get review. Add the authoritative source for a regulatory exception. Use `rule-policy: business <registered-id> <reason>` for an already-wired rule. The initial engine has exact-line classifications in `scripts/business-rules-classifications.json`. A changed line is reviewed again. Static matching is a detection aid, so reviewers also inspect unflagged defaults, string comparisons, and decisions.

Apply the specific forward migrations in order before releasing the frontend. Verify the target database identity, migrations, existing roles and Storage limits, then test using a separate fixture or a rolled-back transaction. Never republish the draft merely to make a production smoke test pass. A read-only visit to the sign-in screen does not verify authenticated acceptance.

## First integration

The LMS learning attachment rule `lms.unit_upload_max_bytes` lives under Learning Management → Courses, in the LMS Content & Uploads category. It starts as a review-only draft copied from the Storage bucket. The existing Storage ceiling remains the documented behavior when no rule applies, and it remains the infrastructure ceiling after publication. The database attachment trigger checks the uploaded object's actual Storage metadata. Lower limits govern new attachments and allow editing the titles and visibility of existing ones. Files that already exceed a newly published policy remain accessible under existing permissions. If publication changes between preflight and attachment, the backend rechecks and the UI removes a rejected upload.

Versions use inclusive Melbourne calendar dates. The latest effective start date takes precedence, followed by higher priority and version. Two future versions for the same identifier cannot share a start date and priority. Publishing an inactive version disables the selected rule during its window. An earlier eligible version can become effective again when a temporary version ends. Rollback creates a fresh draft and goes through the same publishing and approval steps. Previously effective second-administrator requirements apply to later changes, including a change to that requirement itself.

See the [source audit](BUSINESS_RULES_AUDIT.md) for follow-on migrations.
