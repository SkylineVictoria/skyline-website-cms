-- Student Offer Letter: the discount rows of the fee table print only for a course with a discount ({{#if discount}} ... {{/if}},
-- supabase/functions/_shared/letter-variables.ts expandLetterBlocks, released with document-signing v13; version 20261116140000: 20261116120000 (class_sessions_reset) and 20261116130000 (intake_study_load) belong to other sessions of the same day). Applied only to the saved
-- template that still lacks the block and holds each replace target exactly once (checked on hosted 2026-11-16: once each); a new
-- version row is written like a save from the editor. Additive, data only.
do $$
declare
  t hr.sign_templates;
  open_target constant text := '<tr><td style="border:1px solid #808080"><p>Discount (';
  close_target constant text := '{{fees.tuition_after_discount}}</p></td></tr>';
begin
  update hr.sign_templates set
    body_html = replace(replace(body_html,
      open_target,
      '<tr><td colspan="2" style="border:1px solid #808080">{{#if discount}}</td></tr>' || open_target),
      close_target,
      close_target || '<tr><td colspan="2" style="border:1px solid #808080">{{/if}}</td></tr>'),
    version = version + 1, updated_at = now()
  where name = 'Student Offer Letter' and deleted_at is null
    and body_html not like '%{{#if discount}}%'
    and (length(body_html) - length(replace(body_html, open_target, ''))) = length(open_target)
    and (length(body_html) - length(replace(body_html, close_target, ''))) = length(close_target)
  returning * into t;
  if t.id is not null then
    insert into hr.sign_template_versions (template_id, version, snapshot, created_by)
    values (t.id, t.version, to_jsonb(t), t.created_by);
  end if;
end $$;
