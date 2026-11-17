// Agent onboarding in stages (2026-11-17): the administrator actions of the business page (send the application form, send the
// referee checks again, change a referee, upload a referee's form, send the agreement) and what runs after a signature (the referee
// checks go out when the agent has signed the form; staff are told when both referees are back). Everything goes through the Sign
// module: PDF templates installed from the blanks, the sender's values printed, the signer's fields placed, the emailed link. The
// database decides the stages (public.agency_onboarding_*); this module makes the PDFs and the emails. Runtime-neutral (tests mock the ports).
import { AGENT_ONBOARDING_DOCS, expiryDate, isPdfDate, resolveFields, signerRole, type OnboardingDoc, type PlacedField } from "../_shared/agent-onboarding.ts";
import { lookupAgencyAbn } from "../_shared/validation/abn.ts";
import { checkRecipients, signingNameValid } from "../_shared/signing.ts";
import { toBase64 } from "../_shared/notification/attachment.ts";
import { outcomeState } from "../_shared/hr-mail.ts";
import { drainSigningMail, isoToday, ONBOARDING_TEMPLATES_MISSING, sha256Hex, SigningError, type RpcError, type SigningPorts } from "./core.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const onboardingPdfModule = () => import("../_shared/agent-onboarding-pdf.ts");
const signingPdfModule = () => import("../_shared/signing-pdf.ts");
// deno-lint-ignore no-explicit-any
type Json = any;

/** What an action needs from the function: the caller's RPCs, the service RPCs, the bucket and the staged-file bookkeeping. */
export interface OnboardingContext {
  ports: SigningPorts;
  body: Record<string, unknown>;
  upload: { name: string; bytes: Uint8Array } | null;
  admin(operation: string, id?: unknown, data?: unknown): Promise<Json>;
  rpc(name: string, args: Record<string, unknown>): Promise<Json>;
  store(path: string, bytes: Uint8Array): Promise<void>;
  fileBytes(path: string, expected: string): Promise<Uint8Array>;
  /** Marks the staged files as committed (the database row that references them exists). */
  commit(): void;
}
interface OnboardingTemplate { id: string; systemKey: string; status: string; sourcePath: string; sourceHash: string; sourcePages: number; fields: PlacedField[]; expiryDays: number; reminderDays: number }

const text = (value: unknown, max: number) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); // eslint-disable-line no-control-regex
const serviceRpc = async (ports: SigningPorts, name: string, args: Record<string, unknown>) => {
  if (!ports.serviceRpc) throw new SigningError("Not available.");
  try { return await ports.serviceRpc(name, args); }
  catch (error) { const e = error as RpcError; throw new SigningError(e.message, e.code === "42501" ? 403 : 400); }
};
const numbered = (fields: PlacedField[], offset = 0) => fields.map((f) => ({ ...f, page: Number(f.page) + offset, x: Number(f.x), y: Number(f.y), w: Number(f.w), h: Number(f.h) }));

/**
 * One of the three blanks (uploaded by the CMS from public/templates) as a PDF template of the Sign module, marked by its system key.
 * Installing is idempotent: a template already holding the key is reused (an archived one comes back active) and the upload is ignored;
 * otherwise the blank is stored and the database claims the key (insert ... on conflict do nothing, then select), so two sends installing
 * at once end with one template and the loser removes its copy of the file.
 */
export async function installBlank(ctx: OnboardingContext): Promise<Json> {
  await ctx.admin("subject_search", null, { type: "none" });
  const which = String(ctx.body.which ?? "") as OnboardingDoc;
  const spec = AGENT_ONBOARDING_DOCS[which];
  if (!spec) throw new SigningError("Say which blank to install: form, referee or agreement.");
  const installed = ((await ctx.rpc("agency_onboarding_templates", {})) as OnboardingTemplate[]).find((t) => t.systemKey === spec.key);
  // refresh: the blank shipped with the site changed; the same template takes the new file and the fields read from it (no new row).
  const refresh = ctx.body.refresh === true && !!installed;
  if (installed && !refresh) {
    const kept = await ctx.rpc("agency_onboarding_template_install", { p_key: spec.key, p_data: null });
    if (kept?.id) return { id: kept.id, systemKey: spec.key, fields: Number(kept.fields ?? installed.fields?.length ?? 0), pages: Number(kept.pages ?? installed.sourcePages), reused: true };
  }
  if (!ctx.upload) throw new SigningError(`Choose the ${spec.name} PDF.`);
  if (await sha256Hex(ctx.upload.bytes) !== spec.sha256) throw new SigningError(`This file is not the ${spec.name} blank (checksum mismatch). Use the copy shipped with the site.`);
  let read: Awaited<ReturnType<Awaited<ReturnType<typeof onboardingPdfModule>>["readBlankTemplate"]>>;
  try { read = await (await onboardingPdfModule()).readBlankTemplate(which, ctx.upload.bytes); }
  catch (error) { throw new SigningError((error as Error).message); }
  const id = ctx.ports.uuid();
  const path = `templates/${id}/source-${ctx.ports.uuid()}.pdf`;
  await ctx.store(path, read.flattened);
  const result = await ctx.rpc("agency_onboarding_template_install", { p_key: spec.key, p_data: { id, name: spec.name, title: spec.title, category: spec.category, roles: [signerRole(which)], fields: read.fields,
    signing_mode: "sequential", expiry_days: 30, reminder_days: 3, source_path: path, source_hash: await sha256Hex(read.flattened), source_pages: read.pages, refresh } });
  if (result?.refreshed) { ctx.commit(); return { id: result.id, systemKey: spec.key, fields: read.fields.length, pages: read.pages, reused: false, refreshed: true, version: Number(result.version ?? 0) }; }
  if (result?.reused) {
    // Another send installed this blank first: its template is the one; this upload is not referenced by anything.
    try { await ctx.ports.storage.remove([path]); } catch { /* left for a later clean-up */ }
    ctx.commit();
    return { id: result.id, systemKey: spec.key, fields: Number(result.fields ?? 0), pages: Number(result.pages ?? read.pages), reused: true };
  }
  ctx.commit();
  return { id: result?.id ?? id, systemKey: spec.key, fields: read.fields.length, pages: read.pages, reused: false };
}

async function installedTemplate(ctx: OnboardingContext, which: OnboardingDoc): Promise<OnboardingTemplate> {
  const templates = (await ctx.rpc("agency_onboarding_templates", {})) as OnboardingTemplate[];
  const found = templates.find((t) => t.systemKey === AGENT_ONBOARDING_DOCS[which].key && t.status === "active");
  // The CMS reads the name in brackets and installs that blank (public/templates), then tries again.
  if (!found) throw new SigningError(`${ONBOARDING_TEMPLATES_MISSING} (${which})`);
  return found;
}

/** The document of one template for one send: the sender's values printed into it, the signer's fields to place. */
async function buildDocument(ctx: OnboardingContext, template: OnboardingTemplate, values: Record<string, string>, title: string) {
  const source = await ctx.fileBytes(template.sourcePath, template.sourceHash);
  const { printed, recipient } = resolveFields(numbered(template.fields), values);
  let bytes = source;
  if (printed.length) {
    bytes = await (await signingPdfModule()).stampDocument(source, { reference: "", title, recipients: [],
      fields: printed.map((f) => ({ recipient_id: null, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, value: f.value, done: true, label: f.label })) });
  }
  return { bytes, printed, recipient };
}
const recipientFields = (fields: PlacedField[], role: string) => fields.map((f) => ({ type: f.type, role, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, label: f.label, key: f.key, value: f.value }));

interface Prepared {
  agency: { id: string; name: string; abn: string | null }; agent: { id: string; name: string; email: string } | null;
  admin: { name: string; position: string; signaturePng: string | null }; values: Record<string, unknown>;
}
async function prepare(ctx: OnboardingContext, agencyId: string, agentId: unknown): Promise<Prepared> {
  if (!UUID.test(agencyId)) throw new SigningError("Choose a business.");
  const prepared = await ctx.rpc("agency_onboarding_prepare", { p_agency: agencyId, p_agent: UUID.test(String(agentId ?? "")) ? agentId : null }) as Prepared;
  if (!prepared?.agent) throw new SigningError("This business has no active agent to send the documents to. Add its business admin agent first.");
  return prepared;
}
/** The values our records give, plus the ABN Lookup (legal entity, trading name, GST, state, postcode). Unavailable: left for the agent. */
async function recordValues(prepared: Prepared): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(prepared.values ?? {})) if (typeof value === "string" && value.trim()) values[key] = value.trim();
  if (prepared.agency.abn) {
    try {
      const abr = await lookupAgencyAbn(prepared.agency.abn);
      if (abr.legalName) { values.agent_legal_entity ||= abr.legalName; values.agent_organisation_name = abr.legalName; }
      if (abr.businessNames?.[0]) values.agent_trading_name ||= abr.businessNames[0];
      if (/^registered/i.test(abr.gstStatus ?? "")) values.agent_gst_registered ||= "YES"; else if (/not/i.test(abr.gstStatus ?? "")) values.agent_gst_registered ||= "NO";
      if (abr.state) values.office_state ||= abr.state;
      if (abr.postcode) values.office_province ||= abr.postcode;
    } catch { /* the lookup is a convenience: the agent types what it would have printed */ }
  }
  return values;
}

/** Stage 1: the application form (F04) to the business's agent. */
export async function sendApplication(ctx: OnboardingContext): Promise<Json> {
  const agencyId = String(ctx.body.agencyId ?? "");
  const prepared = await prepare(ctx, agencyId, ctx.body.agentId);
  const template = await installedTemplate(ctx, "form");
  // The referee checks go out by themselves when the form is signed (no browser to install a blank then): all three must exist now.
  await installedTemplate(ctx, "referee"); await installedTemplate(ctx, "agreement");
  const values = await recordValues(prepared);
  const title = `Agent application form: ${text(prepared.agency.name, 150)}`.slice(0, 200);
  const made = await buildDocument(ctx, template, values, title);
  const recipients = checkRecipients([{ name: prepared.agent!.name, email: prepared.agent!.email, role: signerRole("form").key, label: signerRole("form").label, order: 1, required: true }]);
  const id = ctx.ports.uuid();
  await ctx.store(`${id}/original.pdf`, made.bytes);
  const record = await ctx.admin("create", id, { title, template_id: template.id, rendered_text: null, field_values: values, original_hash: await sha256Hex(made.bytes), recipients,
    fields: recipientFields(made.recipient, signerRole("form").key), subject_type: "agent", subject_id: prepared.agent!.id, category: "other", message: text(ctx.body.message, 2000) || null, edited: false,
    template_text: null, signing_mode: "sequential", expiry_days: template.expiryDays ?? 30, reminder_days: template.reminderDays ?? 3 });
  const onboarding = await ctx.rpc("agency_onboarding_create", { p_agency: agencyId, p_agent: prepared.agent!.id, p_request: id,
    p_data: { form_pages: template.sourcePages, values, message: text(ctx.body.message, 2000) || null, admin_name: text(prepared.admin?.name, 150) } });
  ctx.commit();
  return await sendRequest(ctx, id, { reference: record.reference, onboardingId: onboarding.id, stage: onboarding.stage, agent: { name: prepared.agent!.name, email: prepared.agent!.email }, printed: made.printed.length, fields: made.recipient.length });
}
async function sendRequest(ctx: OnboardingContext, id: string, result: Record<string, unknown>) {
  const { provider, config } = ctx.ports.mail;
  if (!provider || !config.siteUrl || !config.from) return { id, ...result, sent: false, warning: "Signing email is not configured, so nothing was emailed. The request was kept as a draft: send it from the request." };
  const sent = await ctx.admin("send", id, {});
  const mail = await drainSigningMail(ctx.ports);
  return { id, ...result, sent: true, state: sent.state, mail };
}

/** Stage 3: the agreement (P06) to the agent, at References received or earlier with a typed reason. */
export async function sendAgreement(ctx: OnboardingContext): Promise<Json> {
  const onboardingId = String(ctx.body.onboardingId ?? "");
  if (!UUID.test(onboardingId)) throw new SigningError("Choose an onboarding.");
  const prepared = await prepare(ctx, String(ctx.body.agencyId ?? ""), ctx.body.agentId);
  const template = await installedTemplate(ctx, "agreement");
  const commencement = text(ctx.body.commencementDate, 10);
  if (!isPdfDate(commencement) || Number.isNaN(Date.parse(commencement))) throw new SigningError("Enter the commencement date.");
  const territory = text(ctx.body.territory, 200);
  if (!territory) throw new SigningError("Enter the territory (Item 3).");
  const commission = text(ctx.body.commissionPercent, 10).replace(/%/g, "");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(commission) || Number(commission) > 100) throw new SigningError("Enter the commission as a percentage, for example 25.");
  const adminName = text(ctx.body.adminName ?? prepared.admin?.name, 150);
  const adminPosition = text(ctx.body.adminPosition ?? prepared.admin?.position, 150);
  if (!adminName) throw new SigningError("Enter the name of the SLIT signatory.");
  if (!adminPosition) throw new SigningError("Enter the position of the SLIT signatory.");
  const signature = ctx.body.adminSignature && typeof ctx.body.adminSignature === "object" ? ctx.body.adminSignature as { kind?: string; png?: string; name?: string; save?: boolean } : {};
  const pdf = await signingPdfModule();
  let adminSignature = "";
  if (signature.kind === "saved") {
    if (!prepared.admin?.signaturePng) throw new SigningError("You have no saved signature yet. Draw one, or type your name.");
    adminSignature = `data:image/png;base64,${prepared.admin.signaturePng}`;
  } else if (signature.kind === "drawn") {
    const bytes = pdf.signatureImageBytes(signature.png);
    adminSignature = `data:image/png;base64,${toBase64(bytes)}`;
    if (signature.save === true) await ctx.rpc("cms_user_signature_save", { p_png: toBase64(bytes) });
  } else {
    adminSignature = text(signature.name ?? adminName, 150);
    if (!signingNameValid(adminSignature)) throw new SigningError("Type the signatory's name as the signature, or draw one.");
  }
  const values = await recordValues(prepared);
  Object.assign(values, { agreement_commencement_date: commencement, agent_territory: territory, agent_commission_percent: commission, admin_name: adminName, admin_position: adminPosition,
    admin_signed_date: isoToday(), admin_witness_name: text(ctx.body.adminWitnessName, 150), admin_witness_signature: text(ctx.body.adminWitnessName, 150), admin_signature: adminSignature });
  const title = `Agent agreement: ${text(prepared.agency.name, 150)}`.slice(0, 200);
  const made = await buildDocument(ctx, template, values, title);
  const sentValues = Object.fromEntries(Object.entries(values).filter(([key]) => key !== "admin_signature"));
  const recipients = checkRecipients([{ name: prepared.agent!.name, email: prepared.agent!.email, role: signerRole("agreement").key, label: signerRole("agreement").label, order: 1, required: true }]);
  const id = ctx.ports.uuid();
  await ctx.store(`${id}/original.pdf`, made.bytes);
  const record = await ctx.admin("create", id, { title, template_id: template.id, rendered_text: null, field_values: sentValues, original_hash: await sha256Hex(made.bytes), recipients,
    fields: recipientFields(made.recipient, signerRole("agreement").key), subject_type: "agent", subject_id: prepared.agent!.id, category: AGENT_ONBOARDING_DOCS.agreement.category,
    message: text(ctx.body.message, 2000) || null, edited: false, template_text: null, signing_mode: "sequential", expiry_days: template.expiryDays ?? 30, reminder_days: template.reminderDays ?? 3 });
  const onboarding = await ctx.rpc("agency_onboarding_agreement_create", { p_onboarding: onboardingId, p_request: id, p_data: { commencement_date: commencement, expiry_date: expiryDate(commencement),
    territory, commission_percent: commission, admin_name: adminName, admin_position: adminPosition, values: sentValues, override_reason: text(ctx.body.overrideReason, 500) || null } });
  ctx.commit();
  return await sendRequest(ctx, id, { reference: record.reference, onboardingId, stage: onboarding.stage, override: onboarding.override === true, printed: made.printed.length, fields: made.recipient.length });
}

interface Followup {
  id: string; stage: string; agency: { id: string; name: string }; agent: { id: string; name: string; email: string }; sentBy: { email: string | null; name: string | null }; contacts: string[];
  values: Record<string, string>; referees: Array<{ id: string; position: number; name: string; organisation: string; positionTitle: string; email: string; phone: string; address: string; status: string; requestId: string | null }>;
  received: number; total: number; template: OnboardingTemplate | null; notified: { agentReferees: boolean; staffReferences: boolean };
}
const SIGN_OFF = "\n\nSkyline Institute of Technology\nThis is an automated message.";

/**
 * Stage 2: an Agent Referee Check Form (F05) to every referee still to be contacted, prefilled from the signed application form. Runs
 * when the agent has signed (no administrator session: the service role makes the requests, as the offer letter's are made) and from
 * the business page (Send referee checks, a changed email). The agent is told once that their referees were contacted.
 */
export async function sendRefereeChecks(ctx: Pick<OnboardingContext, "ports" | "store" | "fileBytes" | "commit">, onboardingId: string): Promise<{ sent: number; skipped: number }> {
  const { ports } = ctx;
  const follow = await serviceRpc(ports, "agency_onboarding_followup", { p_onboarding: onboardingId }) as Followup;
  if (!["application_signed", "references_pending"].includes(follow.stage)) return { sent: 0, skipped: follow.referees?.length ?? 0 };
  const pending = (follow.referees ?? []).filter((r) => r.status === "pending" && !r.requestId);
  if (!pending.length) return { sent: 0, skipped: 0 };
  if (!follow.template || follow.template.status !== "active") throw new SigningError(ONBOARDING_TEMPLATES_MISSING);
  const template = follow.template;
  const pdf = await signingPdfModule();
  let sent = 0;
  for (const referee of pending) {
    const values: Record<string, string> = { agent_agency_name: follow.values?.agent_agency_name ?? follow.agency.name, agent_office_address: follow.values?.agent_office_address ?? "",
      referee_organisation: referee.organisation, referee_address: referee.address, referee_contact_person_1: [referee.name, referee.positionTitle].filter((v) => v && v.trim()).join(", "),
      referee_phone: referee.phone, referee_email: referee.email };
    const source = await ctx.fileBytes(template.sourcePath, template.sourceHash);
    const { printed, recipient } = resolveFields(numbered(template.fields), values);
    const title = `Agent referee check: ${text(follow.agency.name, 120)} (reference ${referee.position})`.slice(0, 200);
    const bytes = printed.length ? await pdf.stampDocument(source, { reference: "", title, recipients: [],
      fields: printed.map((f) => ({ recipient_id: null, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, value: f.value, done: true, label: f.label })) }) : source;
    const id = ports.uuid();
    await ctx.store(`${id}/original.pdf`, bytes);
    const message = `${text(follow.agent.name, 80)} of ${text(follow.agency.name, 120)} has applied to become an education agent for Skyline Institute of Technology and named you as a referee. `
      + "Please review the details, complete the form and sign it online. If you would rather, you can also email the completed form to the address printed on it.";
    await serviceRpc(ports, "agency_onboarding_referee_request_create", { p_referee: referee.id, p_data: { id, title, original_hash: await sha256Hex(bytes), template_id: template.id,
      fields: recipientFields(recipient, signerRole("referee").key), message, expiry_days: template.expiryDays ?? 30, reminder_days: template.reminderDays ?? 3,
      values: Object.fromEntries(Object.entries(values).filter(([key]) => key !== "referee_email")) } });
    ctx.commit();
    sent++;
  }
  await drainSigningMail(ports);
  // The agent: their referees have been contacted (once).
  const { provider, config } = ports.mail;
  if (sent && provider && config.from && !follow.notified.agentReferees && follow.agent.email) {
    const names = (follow.referees ?? []).map((r) => `${r.name || r.email}${r.organisation ? ` (${r.organisation})` : ""}`).join(" and ");
    const outcome = outcomeState(await provider.send({ deliveryId: `onboarding-referees-${onboardingId}`, from: config.from, to: follow.agent.email, subject: "Your referees have been contacted",
      textBody: `Hello ${text(follow.agent.name, 80) || "there"},\n\nThank you for signing the Agent Application Form for ${text(follow.agency.name, 120)}. We have emailed a referee check form to ${names}. `
        + "Once both referees have completed it, our team will send you the Agent Agreement. You can see where things are up to on your agency dashboard." + SIGN_OFF }));
    if (outcome.state === "sent") await serviceRpc(ports, "agency_onboarding_mark_notified", { p_onboarding: onboardingId, p_kind: "agent_notified_referees", p_detail: { to: follow.agent.email, referees: sent } }).catch(() => undefined);
  }
  return { sent, skipped: 0 };
}

/** Both referees are back: the staff member who started the onboarding and the admissions contact are told (once). */
export async function notifyReferencesReceived(ctx: Pick<OnboardingContext, "ports">, onboardingId: string): Promise<{ notified: boolean }> {
  const { ports } = ctx;
  const follow = await serviceRpc(ports, "agency_onboarding_followup", { p_onboarding: onboardingId }) as Followup;
  if (follow.stage !== "references_received" || follow.notified.staffReferences) return { notified: false };
  const { provider, config } = ports.mail;
  const to = [...new Set([follow.sentBy?.email, ...(follow.contacts ?? []), ...(follow.sentBy?.email ? [] : config.adminTo)].filter((e): e is string => !!e && /@/.test(e)).map((e) => e.toLowerCase()))];
  if (!provider || !config.from || !to.length) return { notified: false };
  const lines = (follow.referees ?? []).map((r) => `- ${r.name || r.email}${r.organisation ? `, ${r.organisation}` : ""}: ${r.status === "received" ? "received" : r.status}`).join("\n");
  const outcome = outcomeState(await provider.send({ deliveryId: `onboarding-references-${onboardingId}`, from: config.from, to: to.join(", "), subject: `References received: ${text(follow.agency.name, 120)}`,
    textBody: `Both referee checks for ${text(follow.agent.name, 80)} (${text(follow.agency.name, 120)}) are in.\n\n${lines}\n\nOpen the business in the CMS (Businesses > ${text(follow.agency.name, 120)}) to read them and send the Agent Agreement.` + SIGN_OFF }));
  if (outcome.state !== "sent") return { notified: false };
  await serviceRpc(ports, "agency_onboarding_mark_notified", { p_onboarding: onboardingId, p_kind: "staff_notified_references", p_detail: { to } }).catch(() => undefined);
  return { notified: true };
}

/** After a link holder's signature completed a request of an onboarding: the referee checks after the form, the staff email after the second referee. */
export async function afterCompletion(ctx: Pick<OnboardingContext, "ports" | "store" | "fileBytes" | "commit">, plan: { id: string; kind?: string }): Promise<void> {
  if (plan.kind === "application") await sendRefereeChecks(ctx, plan.id);
  else if (plan.kind === "referee") await notifyReferencesReceived(ctx, plan.id);
}

/** Business page: send the referee checks still outstanding (after a failed automatic send, or a changed email address). */
export async function sendRefereesNow(ctx: OnboardingContext): Promise<Json> {
  await ctx.admin("subject_search", null, { type: "none" });
  const onboardingId = String(ctx.body.onboardingId ?? "");
  if (!UUID.test(onboardingId)) throw new SigningError("Choose an onboarding.");
  return await sendRefereeChecks(ctx, onboardingId);
}

/** Business page: a referee's email address (and name) changes; the old request is voided and a new referee check goes out. */
export async function changeReferee(ctx: OnboardingContext): Promise<Json> {
  const refereeId = String(ctx.body.refereeId ?? "");
  if (!UUID.test(refereeId)) throw new SigningError("Choose a referee.");
  const changed = await ctx.rpc("agency_onboarding_referee_change_email", { p_referee: refereeId, p_email: text(ctx.body.email, 254), p_name: text(ctx.body.name, 150) || null }) as { onboardingId: string; previousRequestId: string | null; email: string };
  if (changed.previousRequestId) { try { await ctx.admin("void", changed.previousRequestId, { reason: "Referee email address changed" }); } catch { /* already closed */ } }
  const result = await sendRefereeChecks(ctx, changed.onboardingId);
  return { ...changed, ...result };
}

/** Business page: a signed referee check received by email, uploaded by staff; it counts as received and the open request is voided. */
export async function uploadRefereeForm(ctx: OnboardingContext): Promise<Json> {
  const refereeId = String(ctx.body.refereeId ?? "");
  if (!UUID.test(refereeId)) throw new SigningError("Choose a referee.");
  if (!ctx.upload) throw new SigningError("Choose the signed referee check (PDF).");
  const inspected = await (await import("../_shared/offer-pdf.ts")).inspectOfferPdf(ctx.upload.bytes);
  if (!inspected.ok) throw new SigningError(inspected.error.replaceAll("offer letter", "referee check"));
  const stored = await ctx.rpc("agency_onboarding_referee_upload", { p_referee: refereeId, p_file_name: text(ctx.upload.name, 200) || "referee-check.pdf", p_base64: toBase64(ctx.upload.bytes) }) as { onboardingId: string; previousRequestId: string | null; stage: string };
  if (stored.previousRequestId) { try { await ctx.admin("void", stored.previousRequestId, { reason: "Signed referee check received by email" }); } catch { /* already closed */ } }
  const notified = await notifyReferencesReceived(ctx, stored.onboardingId);
  return { ...stored, ...notified };
}

export const ONBOARDING_ACTIONS: Record<string, (ctx: OnboardingContext) => Promise<Json>> = {
  agent_onboarding_install: installBlank,
  agent_onboarding_send: sendApplication,
  agent_onboarding_send_application: sendApplication,
  agent_onboarding_send_agreement: sendAgreement,
  agent_onboarding_send_referees: sendRefereesNow,
  agent_onboarding_referee_change: changeReferee,
  agent_onboarding_referee_upload: uploadRefereeForm,
};
