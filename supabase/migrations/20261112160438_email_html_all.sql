-- Every application email is sent as professional HTML (plus the plain text), branded from the Website settings.
--  * email_html_wrap(tenant, subject, body): logo header, the message (paragraphs, links; a "Label: https://..." line becomes a
--    button), and a footer with the legal name, address, phone, email, ABN, RTO and CRICOS of that institute.
--  * notification_deliveries gets html_body on insert (ticket emails keep their own richer HTML).
--  * The email-sender Edge Function sends every queued email except application_submitted (whose PDF is built by
--    notification-delivery, unchanged); it attaches the offer letter and CoE / VoE PDFs through the existing database reads.

create or replace function public.email_html_wrap(p_tenant uuid, p_subject text, p_body text)
 returns text language plpgsql stable security definer set search_path to 'public'
as $$
declare
  s jsonb; v_name text; v_logo text; v_color text; v_footer text; v_html text := ''; v_para text; v_line text; v_label text; v_url text;
  v_lines text[]; v_out text[]; v_m text[];
begin
  select to_jsonb(c) into s from public.cms_settings c where c.tenant_id is not distinct from p_tenant order by c.id limit 1;
  v_name := coalesce(nullif(btrim(s->>'name'), ''), 'Skyline Institute of Technology');
  v_logo := nullif(btrim(coalesce(s->>'logo', '')), '');
  v_color := case when coalesce(s->>'primary_color', '') ~ '^#[0-9A-Fa-f]{6}$' then s->>'primary_color' else '#ea6619' end;

  foreach v_para in array regexp_split_to_array(btrim(coalesce(p_body, ''), E' \n\r\t'), E'\\n\\s*\\n') loop
    v_out := '{}';
    v_lines := regexp_split_to_array(v_para, E'\\n');
    foreach v_line in array v_lines loop
      -- A line ending "...sentence. Label (note): https://..." -> the sentence text, then a button "Label" with the note under it.
      v_m := regexp_match(v_line, '^(.*[.!?]\s+)?([^.!?:]{2,90}?)\s*(\(([^)]{1,60})\))?\s*:\s*(https?://[^\s<>"]+)\s*$');
      if v_m is not null then
        v_url := v_m[5];
        v_label := btrim(v_m[2]);
        v_out := v_out || (case when nullif(btrim(coalesce(v_m[1], '')), '') is not null then public.support_html(btrim(v_m[1])) || '</p><p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#111827;">' else '' end
          || '<table role="presentation" cellspacing="0" cellpadding="0" style="margin:6px 0 4px;"><tr><td style="background:' || v_color || ';border-radius:6px;">'
          || '<a href="' || public.support_html(v_url) || '" style="display:inline-block;padding:12px 24px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">'
          || public.support_html(v_label) || '</a></td></tr></table>'
          || case when v_m[4] is not null then '<div style="font-size:12px;color:#6b7280;">' || public.support_html(initcap(left(v_m[4], 1)) || substr(v_m[4], 2)) || '</div>' else '' end);
      else
        v_out := v_out || regexp_replace(public.support_html(v_line), '(https?://[^\s<>"]+)', '<a href="\1" style="color:' || v_color || ';">\1</a>', 'g');
      end if;
    end loop;
    v_html := v_html || '<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#111827;">' || array_to_string(v_out, '<br>') || '</p>';
  end loop;

  v_footer := public.support_html(coalesce(nullif(btrim(s->>'legal_name'), ''), v_name))
    || case when nullif(btrim(coalesce(s->>'address', '')), '') is not null then '<br>' || public.support_html(s->>'address') else '' end
    || '<br>' || concat_ws(' &middot; ',
         case when nullif(btrim(coalesce(s->>'phone', '')), '') is not null then 'Phone ' || public.support_html(s->>'phone') end,
         case when nullif(btrim(coalesce(s->>'email', '')), '') is not null then '<a href="mailto:' || public.support_html(s->>'email') || '" style="color:#6b7280;">' || public.support_html(s->>'email') || '</a>' end,
         case when nullif(btrim(coalesce(s->>'abn', '')), '') is not null then 'ABN ' || public.support_html(s->>'abn') end,
         case when nullif(btrim(coalesce(s->>'rto', '')), '') is not null then 'RTO ' || public.support_html(s->>'rto') end,
         case when nullif(btrim(coalesce(s->>'cricos', '')), '') is not null then 'CRICOS ' || public.support_html(s->>'cricos') end);

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' || public.support_html(p_subject) || '</title></head>'
    || '<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">'
    || '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;"><tr><td align="center" style="padding:24px 12px;">'
    || '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;">'
    || '<tr><td style="padding:18px 24px;border-bottom:4px solid ' || v_color || ';background:#ffffff;">'
    || case when v_logo is not null and v_logo ~ '^https://' then '<img src="' || public.support_html(v_logo) || '" alt="' || public.support_html(v_name) || '" height="48" style="display:block;height:48px;width:auto;border:0;">'
            else '<div style="font-size:20px;font-weight:700;color:' || v_color || ';">' || public.support_html(v_name) || '</div>' end
    || '</td></tr>'
    || '<tr><td style="padding:26px 24px 10px;">'
    || '<h1 style="margin:0 0 16px;font-size:19px;line-height:1.35;color:#111827;">' || public.support_html(p_subject) || '</h1>'
    || v_html
    || '</td></tr>'
    || '<tr><td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#6b7280;">' || v_footer
    || '<br><span style="color:#9ca3af;">This email was sent by ' || public.support_html(v_name) || '. Please do not reply to this address.</span></td></tr>'
    || '</table></td></tr></table></body></html>';
end $$;
revoke all on function public.email_html_wrap(uuid, text, text) from public, anon, authenticated;

create or replace function public.notification_delivery_html()
 returns trigger language plpgsql security definer set search_path to 'public'
as $$
begin
  if new.html_body is null and new.event not like 'support_ticket%' then
    new.html_body := public.email_html_wrap(new.tenant_id, new.subject, new.body);
  end if;
  return new;
end $$;
revoke all on function public.notification_delivery_html() from public, anon, authenticated;
drop trigger if exists notification_delivery_html on public.notification_deliveries;
create trigger notification_delivery_html before insert on public.notification_deliveries
  for each row execute function public.notification_delivery_html();

-- Routing: notification-delivery keeps application_submitted (PDF of the form); email-sender sends everything else.
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.notification_claim_delivery()'::regprocedure);
  n := replace(d, $o$and x.event not like 'support_ticket%'$o$, $o$and x.event = 'application_submitted'$o$);
  if n = d then raise exception 'notification_claim_delivery: anchor not found'; end if;
  execute n;

  d := pg_get_functiondef('public.support_mail_claim()'::regprocedure);
  n := replace(d, $o$and x.event like 'support_ticket%'$o$, $o$and x.event <> 'application_submitted'$o$);
  if n = d then raise exception 'support_mail_claim: anchor not found'; end if;
  execute n;

  d := pg_get_functiondef('public.support_mail_dispatch()'::regprocedure);
  n := replace(replace(d, $o$and event like 'support_ticket%'$o$, $o$and event <> 'application_submitted'$o$),
               '/functions/v1/support-ticket-mail', '/functions/v1/email-sender');
  if n = d or n not like '%email-sender%' or n like $o$%event like 'support_ticket%$o$ then raise exception 'support_mail_dispatch: anchor not found'; end if;
  execute n;
end $mig$;
