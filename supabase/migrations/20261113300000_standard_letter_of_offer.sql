-- Student Letter of Offer templates get their own place (owner brief 2026-11-12, follow-up): the institute logo as a variable, and a
-- starter "Standard Letter of Offer" (active, default) whose every token maps to letter_variables. Idempotent.

/* ------------------------------------------------------------------ {{institute.logo}}: the logo from Settings as a picture */
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'public.letter_variables'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%format%' loop
    execute format('alter table public.letter_variables drop constraint %I', c);
  end loop;
  alter table public.letter_variables add constraint letter_variables_format_check check (format in ('text', 'name', 'date', 'money', 'list', 'multiline', 'image'));
end $$;

insert into public.letter_variables(key, grp, label, description, source_kind, source_ref, source_label, format, input_type, required, editable_source, aliases, sample, sort)
values ('institute.logo', 'Institute', 'Logo', 'The logo from Settings, printed as a picture 42 pt high (|h60 for 60 pt)', 'institute', 'logo', 'Settings › Logo', 'image', 'text', false, false,
  '{logo,institute logo,college logo}', '', 605)
on conflict (key) do update set label = excluded.label, description = excluded.description, format = excluded.format, source_label = excluded.source_label, sort = excluded.sort;

/** As 20261113270000, with a picture height (|h42 ... |h200) allowed as a modifier next to |upper, |lower, |title and |raw. */
create or replace function public.letter_template_unmapped(p_html text) returns text[] language sql stable security definer set search_path = public as $$
  with src as (select regexp_replace(coalesce(p_html, ''), '<[^>]*>', '', 'g') as t),
  found as (
    select '{{' || btrim(m[1]) || '}}' tok, 'curly' kind, btrim(m[1]) raw from src, regexp_matches(src.t, '\{\{\s*([^{}]{1,80}?)\s*\}\}', 'g') m
    union all select '$[' || m[1] || ']', 'old', m[1] from src, regexp_matches(src.t, '\$\[([^\[\]]{1,80})\]', 'g') m
    union all select '{' || m[1] || ':inline}', 'old', m[1] from src, regexp_matches(src.t, '\{([A-Za-z][A-Za-z0-9_ ]{0,60}):inline\}', 'g') m
    union all select '[' || m[1] || ']', 'bracket', m[1] from src, regexp_matches(src.t, '(?:^|[^$])\[([^\[\]\n]{1,80})\]', 'g') m
  )
  select coalesce(array_agg(distinct tok order by tok), '{}') from found f
  where (f.kind = 'curly' and (not exists (select 1 from public.letter_variables v where v.key = lower(btrim(split_part(f.raw, '|', 1))))
          or (position('|' in f.raw) > 0 and lower(btrim(split_part(f.raw, '|', 2))) not in ('upper', 'lower', 'raw', 'title')
              and lower(btrim(split_part(f.raw, '|', 2))) !~ '^h[0-9]{2,3}$')))
     or f.kind = 'old'
     or (f.kind = 'bracket' and exists (select 1 from public.letter_variables v, unnest(v.aliases) al where public.letter_norm(al) = public.letter_norm(f.raw)));
$$;

/* ------------------------------------------------------------------ the starter template */
do $$
declare v_admin uuid; t hr.sign_templates;
 v_header text := '<table style="border:none;width:100%"><tr>'
   || '<td style="width:35%;vertical-align:middle">{{institute.logo|h48}}</td>'
   || '<td style="width:65%;text-align:right;vertical-align:middle"><p style="margin-bottom:0pt"><strong style="font-size:12pt">{{institute.name}}</strong></p>'
   || '<p style="margin-bottom:0pt;font-size:8.5pt">{{institute.address}}</p>'
   || '<p style="margin-bottom:0pt;font-size:8.5pt">{{institute.phone}} | {{institute.admissions_email}}</p>'
   || '<p style="margin-bottom:0pt;font-size:8.5pt">RTO {{institute.rto}} | CRICOS {{institute.cricos}}</p></td></tr></table><hr>';
 v_body text := '<p style="text-align:right">{{offer.date}}</p>'
   || '<h2>Letter of Offer and Written Agreement</h2>'
   || '<p>Dear {{student.full_name}},</p>'
   || '<p>Thank you for applying to {{institute.name}}. We are pleased to offer you a place in the course below. This letter and its conditions form the written agreement between you and {{institute.name}}. Please read it carefully, check every detail and accept the offer by {{offer.expiry_date}}.</p>'
   || '<h3>Student details</h3>'
   || '<table style="width:100%"><tr><td style="width:35%"><strong>Full name</strong></td><td>{{student.full_name}}</td></tr>'
   || '<tr><td><strong>Date of birth</strong></td><td>{{student.dob}}</td></tr>'
   || '<tr><td><strong>Passport number</strong></td><td>{{student.passport_number}}</td></tr>'
   || '<tr><td><strong>Nationality</strong></td><td>{{student.nationality}}</td></tr>'
   || '<tr><td><strong>Address</strong></td><td>{{student.address}}</td></tr>'
   || '<tr><td><strong>Application reference</strong></td><td>{{application.reference}}</td></tr></table>'
   || '<h3>Course details</h3>'
   || '<table style="width:100%"><tr><td style="width:35%"><strong>Course</strong></td><td>{{course.code}} {{course.name}}</td></tr>'
   || '<tr><td><strong>CRICOS course code</strong></td><td>{{course.cricos}}</td></tr>'
   || '<tr><td><strong>Intake</strong></td><td>{{course.intake}}</td></tr>'
   || '<tr><td><strong>Start date</strong></td><td>{{course.start_date}}</td></tr>'
   || '<tr><td><strong>End date</strong></td><td>{{course.end_date}}</td></tr></table>'
   || '<h3>Fees</h3>'
   || '<table style="width:100%"><tr><th style="width:65%">Fee</th><th style="text-align:right">Amount</th></tr>'
   || '<tr><td>Tuition fee</td><td style="text-align:right">{{fees.tuition}}</td></tr>'
   || '<tr><td>Enrolment fee (non-refundable)</td><td style="text-align:right">{{fees.enrolment}}</td></tr>'
   || '<tr><td>Material fee</td><td style="text-align:right">{{fees.material}}</td></tr>'
   || '<tr><td><strong>Total course fees</strong></td><td style="text-align:right"><strong>{{fees.total}}</strong></td></tr>'
   || '<tr><td><strong>Initial deposit (due on acceptance)</strong></td><td style="text-align:right"><strong>{{fees.deposit}}</strong></td></tr></table>'
   || '<p><strong>Payment.</strong> The initial deposit is due when you accept this offer; your Confirmation of Enrolment (CoE) is issued once it is received. The remaining fees are paid by the instalment dates in your payment plan. Fees are in Australian dollars and include no GST.</p>'
   || '<p><strong>Overseas Student Health Cover (OSHC).</strong> You must hold OSHC for the full duration of your student visa. If you arrange it yourself, provide the policy details before your CoE is issued.</p>'
   || '<h3>Conditions of this offer</h3>'
   || '<p>{{offer.conditions}}</p>'
   || '<h3>Refunds and late fees</h3>'
   || '<p>Refunds are made under the {{institute.name}} Refund Policy and the ESOS Act 2000. If your visa is refused, the fees paid are refunded less the enrolment fee, on evidence of the refusal. Fees paid after their due date may attract a late payment fee, and unpaid fees can lead to the suspension or cancellation of your enrolment.</p>'
   || '<h3>Acceptance</h3>'
   || '<p>By accepting this offer you confirm that the information in your application is true and complete, and that you have read and agree to this written agreement, the fees and the refund policy.</p>'
   || '<p>Yours sincerely,</p><p><strong>Admissions</strong><br>{{institute.name}}</p>';
 v_footer text := '<p style="font-size:8pt;text-align:center;margin-bottom:0pt">LETTER OF OFFER AND WRITTEN AGREEMENT · Version Nov 2026 · {{student.initial_line}} · Page {{page.number}} of {{page.total}}</p>'
   || '<p style="font-size:7.5pt;text-align:center;margin-bottom:0pt">{{institute.name}} · ABN {{institute.abn}}</p>';
begin
 if exists (select 1 from hr.sign_templates where category = 'student_offer_letter' and name = 'Standard Letter of Offer' and deleted_at is null) then return; end if;
 select c.auth_user_id into v_admin from public.cms_users c where c.role = 'Admin' and c.status = 'Active' and c.auth_user_id is not null order by c.created_at, c.id limit 1;
 if v_admin is null then raise notice 'No active CMS admin: the Standard Letter of Offer was not seeded'; return; end if;
 insert into hr.sign_templates(name, title, body, body_html, header_html, footer_html, kind, audience, category, is_default, bracket_variables, created_by)
 values ('Standard Letter of Offer', 'Letter of Offer', 'Letter of Offer and Written Agreement', v_body, v_header, v_footer, 'text', 'student', 'student_offer_letter',
   not exists (select 1 from hr.sign_templates x where x.category = 'student_offer_letter' and x.is_default and x.deleted_at is null), false, v_admin)
 returning * into t;
 if t.status <> 'active' then raise exception 'The Standard Letter of Offer has unmapped tokens: %', public.letter_template_unmapped(concat_ws(' ', t.title, t.header_html, t.body_html, t.footer_html)); end if;
 insert into hr.sign_template_versions(template_id, version, snapshot, created_by) values (t.id, t.version, to_jsonb(t), v_admin);
end $$;
