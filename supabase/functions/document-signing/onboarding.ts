// Agent onboarding in stages (2026-11-17): the administrator actions of the business page (send the application form, send the
// referee checks again, change a referee, upload a referee's form, send the agreement) and what runs after a signature (the referee
// checks go out when the agent has signed the form; staff are told when both referees are back). Everything goes through the Sign
// module: PDF templates installed from the blanks, the sender's values printed, the signer's fields placed, the emailed link. The
// database decides the stages (public.agency_onboarding_*); this module makes the PDFs and the emails. Runtime-neutral (tests mock the ports).
import { AGENT_ONBOARDING_DOCS, expiryDate, F04_RECORD_KEYS, isPdfDate, normalizeOfficeAddress, resolveFields, signerRole, type OnboardingDoc, type PlacedField } from "../_shared/agent-onboarding.ts";
import { ABR_PREFILL_KEYS, abrFacts, lookupAbr, lookupAbrCached, phoneE164, type AbrConfirmed, type AbrDetails, type AbrFacts } from "../_shared/validation/abr.ts";
import { checkRecipients, signingNameValid } from "../_shared/signing.ts";
import { toBase64 } from "../_shared/notification/attachment.ts";
import { outcomeState } from "../_shared/hr-mail.ts";
import { abrCache, drainSigningMail, f04Prefill, isoToday, ONBOARDING_TEMPLATES_MISSING, sha256Hex, SigningError, type RpcError, type SigningPorts } from "./core.ts";

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
  /** A draft request from a saved template for a record (the Sign module's "create": the record's values printed, the signers' fields placed). */
  createRequest?(input: Record<string, unknown>): Promise<Json>;
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
  // A refreshed template keeps its id: its source files live under templates/<id>/ (hr.sign_templates kind_source check).
  const id = refresh && installed ? installed.id : ctx.ports.uuid();
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
async function buildDocument(ctx: OnboardingContext, template: OnboardingTemplate, values: Record<string, string>, title: string, options: { editablePrefill?: boolean } = {}) {
  const source = await ctx.fileBytes(template.sourcePath, template.sourceHash);
  const { printed, recipient } = resolveFields(numbered(template.fields), values, options);
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
async function recordValues(ctx: OnboardingContext, prepared: Pick<Prepared, "agency" | "values">): Promise<Record<string, string>> {
  return (await recordValuesWithFacts(ctx, prepared)).values;
}
/**
 * The same, with the register's facts (status, entity type, GST date, ACN). The register's answer is cached by ABN (public.abr_businesses,
 * 2026-11-19): a send within 30 days of an earlier lookup does not ask again. One rule with the open (f04Prefill): trading name falls back to
 * the entity name, year founded from the ABN's status date, the ACN from the ASIC table, the postcode in the Suburb box. Our records win.
 */
async function recordValuesWithFacts(ctx: OnboardingContext, prepared: Pick<Prepared, "agency" | "values">): Promise<{ values: Record<string, string>; facts: AbrFacts | null }> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(prepared.values ?? {})) if (typeof value === "string" && value.trim()) values[key] = value.trim();
  let facts: AbrFacts | null = null, register: Record<string, string> = {};
  if (prepared.agency.abn) {
    const found = await lookupAbrCached(prepared.agency.abn, ctx.ports.abr?.guid, abrCache(ctx.ports), ctx.ports.abr?.fetch ?? fetch);
    if (found) {
      facts = abrFacts(found.details, found.fetchedAt);
      if (found.details.entityName) values.agent_organisation_name = found.details.entityName;
      register = f04Prefill({ details: found.details, confirmed: null, record: values });
    }
  }
  const merged = normalizeOfficeAddress({ ...register, ...values });
  const phone = phoneE164(merged.contact_phone); if (phone) merged.contact_phone = phone;
  return { values: merged, facts };
}

/** What the business keeps from ABN Lookup (agencies.abr_*): the register's answer, the values staff confirmed, the contact's names. */
interface BusinessAbr { details: AbrDetails | null; confirmed: (AbrConfirmed & { givenName?: string; familyName?: string }) | null; fetchedAt: string | null }
/**
 * ABN prefill (2026-11-19): a business added with an ABN Lookup confirmation gets the F04 prefilled from what is kept on the business (no new
 * call to the register), every prefilled value editable by the contact; everything else is blank. A business without one keeps the earlier values.
 */
async function applicationValues(ctx: OnboardingContext, prepared: Prepared): Promise<{ values: Record<string, string>; prefill: Record<string, string> | null; facts: AbrFacts | null }> {
  let abr: BusinessAbr | null = null;
  try { abr = await ctx.rpc("agency_abr_get", { p_agency: prepared.agency.id }) as BusinessAbr | null; } catch { abr = null; }
  if (!abr?.confirmed) {
    // No ABR confirmation on the business (EF_ABR_GUID not set): the public page's values, still editable by the contact in the wizard.
    const { values, facts } = await recordValuesWithFacts(ctx, prepared);
    const prefill = Object.fromEntries([...new Set([...ABR_PREFILL_KEYS, ...F04_RECORD_KEYS])].filter((k) => values[k]).map((k) => [k, values[k]]));
    return { values, prefill: Object.keys(prefill).length ? prefill : null, facts };
  }
  const record = prepared.values ?? {};
  const parts = String(prepared.agent?.name ?? "").trim().split(/\s+/);
  // The register's answer kept on the business (staff confirmed it) and the business record (website, title, office, from the sign-up / profile).
  if (abr.details) { const cache = abrCache(ctx.ports); if (cache) await cache.put(abr.details).catch(() => undefined); }
  const prefill = f04Prefill({ details: abr.details, confirmed: { ...abr.confirmed,
    givenName: abr.confirmed.givenName || String(record.contact_given_name ?? "") || parts.slice(0, -1).join(" ") || parts[0] || "",
    familyName: abr.confirmed.familyName || String(record.contact_family_name ?? "") || (parts.length > 1 ? parts[parts.length - 1] : "") },
    record: { ...Object.fromEntries(F04_RECORD_KEYS.map((k) => [k, record[k]])), contact_email: String(prepared.agent?.email ?? ""), contact_phone: String(record.contact_phone ?? "") } });
  return { values: { ...prefill }, prefill, facts: abr.details ? abrFacts(abr.details, abr.fetchedAt ?? new Date().toISOString()) : null };
}

/** Add business: the ABN typed is looked up on the register (EF_ABR_GUID); the answer is cached by ABN for the business about to be saved. */
export async function abnLookup(ctx: OnboardingContext): Promise<Json> {
  await ctx.admin("subject_search", null, { type: "none" });
  const outcome = await lookupAbr(String(ctx.body.abn ?? ""), ctx.ports.abr?.guid, ctx.ports.abr?.fetch ?? fetch);
  if (!outcome.ok) return { configured: outcome.reason !== "not_configured", ok: false, reason: outcome.reason, message: outcome.message };
  let cached = true;
  try { await ctx.rpc("abr_lookup_save", { p_abn: outcome.details.abn, p_raw: outcome.raw, p_details: outcome.details }); } catch { cached = false; }
  return { configured: true, ok: true, details: outcome.details, fetchedAt: outcome.fetchedAt, cached };
}

/** Stage 1: the application form (F04) to the business's agent. */
export async function sendApplication(ctx: OnboardingContext): Promise<Json> {
  const agencyId = String(ctx.body.agencyId ?? "");
  const prepared = await prepare(ctx, agencyId, ctx.body.agentId);
  const template = await installedTemplate(ctx, "form");
  // The referee checks go out by themselves when the form is signed (no browser to install a blank then): all three must exist now.
  await installedTemplate(ctx, "referee"); await installedTemplate(ctx, "agreement");
  const { values, prefill, facts } = await applicationValues(ctx, prepared);
  const title = `Agent application form: ${text(prepared.agency.name, 150)}`.slice(0, 200);
  // F04 wizard (2026-11-19): every value we hold is the contact's to correct (the Company summary's Edit), whatever its source.
  const made = await buildDocument(ctx, template, values, title, { editablePrefill: true });
  const recipients = checkRecipients([{ name: prepared.agent!.name, email: prepared.agent!.email, role: signerRole("form").key, label: signerRole("form").label, order: 1, required: true }]);
  const id = ctx.ports.uuid();
  await ctx.store(`${id}/original.pdf`, made.bytes);
  const record = await ctx.admin("create", id, { title, template_id: template.id, rendered_text: null, field_values: values, original_hash: await sha256Hex(made.bytes), recipients,
    fields: recipientFields(made.recipient, signerRole("form").key), subject_type: "agent", subject_id: prepared.agent!.id, category: "other", message: text(ctx.body.message, 2000) || null, edited: false,
    template_text: null, signing_mode: "sequential", expiry_days: template.expiryDays ?? 30, reminder_days: template.reminderDays ?? 3 });
  let onboarding: Json;
  try {
    onboarding = await ctx.rpc("agency_onboarding_create", { p_agency: agencyId, p_agent: prepared.agent!.id, p_request: id,
      p_data: { form_pages: template.sourcePages, values, message: text(ctx.body.message, 2000) || null, admin_name: text(prepared.admin?.name, 150) } });
  } catch (error) {
    // One open onboarding per business (a double click, a retry): the draft made for this attempt is voided and never emailed.
    try { await ctx.admin("void", id, { reason: "Not sent: the business already has an onboarding in progress" }); } catch { /* left as an unsent draft */ }
    throw error;
  }
  ctx.commit();
  // The onboarding history says which values were prefilled; the database compares them with the signed answers (prefill_reviewed).
  if (prefill) { try { await ctx.rpc("agency_onboarding_prefill_record", { p_onboarding: onboarding.id, p_prefill: prefill }); } catch { /* the form still goes; only the history line is missing */ } }
  // The register's facts (status, entity type, GST date, ACN) on the business profile, shown read-only in the wizard's Company summary.
  if (facts) { try { await ctx.rpc("agency_abr_facts_record", { p_agency: agencyId, p_facts: facts }); } catch { /* the wizard looks them up itself */ } }
  return await sendRequest(ctx, id, { reference: record.reference, onboardingId: onboarding.id, stage: onboarding.stage, agent: { name: prepared.agent!.name, email: prepared.agent!.email }, printed: made.printed.length, fields: made.recipient.length, prefilled: prefill ? Object.keys(prefill).length : 0 });
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
  const values = await recordValues(ctx, prepared);
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

/**
 * Onboarding per business (2026-11-19, owner): Add business saves the business and its point of contact (POC) and sends the Agent
 * Application Form (F04) to the POC at once, in one call. The three blanks are checked before anything is saved, so the CMS can install a
 * missing one and call again without a second business. Only this call sends the first F04: an existing business never gets one by itself
 * (staff use Resend application / Start again). The database allows one open onboarding per business, so a retry cannot send a second F04.
 */
export async function createBusiness(ctx: OnboardingContext): Promise<Json> {
  await ctx.admin("subject_search", null, { type: "none" });
  await installedTemplate(ctx, "form"); await installedTemplate(ctx, "referee"); await installedTemplate(ctx, "agreement");
  const agency = ctx.body.agency && typeof ctx.body.agency === "object" ? ctx.body.agency as Record<string, unknown> : null;
  if (!agency) throw new SigningError("Enter the business's details.");
  const contactName = text(ctx.body.contactName, 100), contactEmail = text(ctx.body.contactEmail, 254).toLowerCase();
  if (contactName.length < 2) throw new SigningError("Enter the point of contact's name (2 to 100 characters).");
  if (!/^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(contactEmail)) throw new SigningError("Enter the point of contact's email address.");
  const created = await ctx.rpc("admin_business_create", { p_agency: agency, p_contact_email: contactEmail, p_contact_name: contactName }) as
    { agencyId: string; businessId: string; agencyName: string; contactAgentId: string };
  // ABN prefill: the values staff confirmed from ABN Lookup (and the register's cached answer) are kept on the business for the F04.
  let abrWarning: string | null = null;
  const abr = ctx.body.abr && typeof ctx.body.abr === "object" ? ctx.body.abr as Record<string, unknown> : null;
  if (abr) {
    try { await ctx.rpc("agency_abr_attach", { p_agency: created.agencyId, p_confirmed: abr }); }
    catch (error) { abrWarning = `The ABN details could not be kept on the business (${(error as Error).message}); the application form goes without the ABN prefill.`; }
  }
  try {
    const application = await sendApplication({ ...ctx, body: { agencyId: created.agencyId, agentId: created.contactAgentId, message: ctx.body.message } });
    return { ...created, application, ...(abrWarning ? { abrWarning } : {}) };
  } catch (error) {
    // The business is saved; the form can be sent again from its page (Resend application).
    return { ...created, application: null, warning: `The business was saved, but the application form could not be sent: ${(error as Error).message}` };
  }
}

/**
 * Activate (2026-11-19): the signed business agreement (or an uploaded signed copy) makes the business Ready to activate; an administrator
 * presses Activate. The database makes the business, its POC and every agent added meanwhile Active and returns the invitations; each gets
 * ONE set-password email here (an invitation already emailed is not emailed again).
 */
interface BusinessActivation {
  businessId: string; name: string; status: string; onboardingId: string | null; contact: { id: string; name: string; email: string }; heldReleased: number;
  invitations: Array<{ id: string; email: string; name: string; role: string; expiresAt: string | null; sent: boolean; contact: boolean; agentId: string }>;
  skipped: Array<{ email: string; reason: string }>;
}
export async function activateBusinessByAdmin(ctx: OnboardingContext): Promise<Json> {
  const businessId = String(ctx.body.businessId ?? "");
  if (!UUID.test(businessId)) throw new SigningError("Choose a business.");
  const result = await ctx.rpc("agency_business_activate", { p_business: businessId }) as BusinessActivation;
  const emailed: string[] = [], failed: string[] = [];
  for (const inv of result.invitations ?? []) {
    if (inv.sent) continue;
    const ok = await sendSetPasswordEmail(ctx.ports, { invitationId: inv.id, email: inv.email, name: inv.name, role: inv.role, agencyName: result.name, expiresAt: inv.expiresAt, kind: inv.contact ? "business" : "member" });
    (ok ? emailed : failed).push(inv.email);
  }
  return { ...result, emailed, failed };
}

/** The business agreement is signed: staff are told the business is ready to activate (once); nothing goes to the business until then. */
export async function notifyBusinessReady(ctx: Pick<OnboardingContext, "ports">, onboardingId: string): Promise<{ notified: boolean }> {
  const { ports } = ctx;
  const follow = await serviceRpc(ports, "agency_onboarding_followup", { p_onboarding: onboardingId }) as Followup;
  if (follow.kind === "agent" || follow.stage !== "agreement_signed") return { notified: false };
  const { provider, config } = ports.mail;
  const to = [...new Set([follow.sentBy?.email, ...(follow.contacts ?? []), ...(follow.sentBy?.email ? [] : config.adminTo)].filter((e): e is string => !!e && /@/.test(e)).map((e) => e.toLowerCase()))];
  if (!provider || !config.from || !to.length) return { notified: false };
  const outcome = outcomeState(await provider.send({ deliveryId: `onboarding-ready-${onboardingId}`, from: config.from, to: to.join(", "),
    subject: `Ready to activate: ${text(follow.agency.name, 120)}`,
    textBody: `${text(follow.agent.name, 80)} has signed the Agent Agreement for ${text(follow.agency.name, 120)}.\n\n`
      + `Open the business in the CMS (Businesses > ${text(follow.agency.name, 120)}) and press Activate. The business goes active, ${text(follow.agent.email, 254)} gets the set-password email, `
      + "and every agent added to the business meanwhile gets their sign-in invitation. Nothing is sent to them until you do." + SIGN_OFF }));
  return { notified: outcome.state === "sent" };
}

/** Agent-level onboarding was retired (2026-11-19): every per-agent action is refused; the business onboarding covers its agents. */
const AGENT_LEVEL_RETIRED = "Agents have no onboarding of their own: the business onboarding covers them. Add the agent; their sign-in invitation goes out when the business is active.";
const retired = (): Promise<Json> => Promise.reject(new SigningError(AGENT_LEVEL_RETIRED, 410));

interface Followup {
  id: string; kind?: "business" | "agent"; stage: string; agency: { id: string; name: string }; agent: { id: string; name: string; email: string }; sentBy: { email: string | null; name: string | null }; contacts: string[];
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
        + (follow.kind === "agent" ? "Once both referees have completed it, our team will review your application and let you know by email."
          : "Once both referees have completed it, our team will send you the Agent Agreement. You can see where things are up to on your agency dashboard.") + SIGN_OFF }));
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
  const agent = follow.kind === "agent";
  const outcome = outcomeState(await provider.send({ deliveryId: `onboarding-references-${onboardingId}`, from: config.from, to: to.join(", "),
    subject: agent ? `Agent references received: ${text(follow.agent.name, 80)} (${text(follow.agency.name, 100)})` : `References received: ${text(follow.agency.name, 120)}`,
    textBody: `Both referee checks for ${text(follow.agent.name, 80)} (${text(follow.agency.name, 120)}) are in.\n\n${lines}\n\n`
      + (agent ? `Open the business in the CMS (Businesses > ${text(follow.agency.name, 120)} > Agents) to read them, then send the agent their individual agent agreement or reject them. The agent can be activated once the agreement is signed.`
        : `Open the business in the CMS (Businesses > ${text(follow.agency.name, 120)}) to read them and send the Agent Agreement.`) + SIGN_OFF }));
  if (outcome.state !== "sent") return { notified: false };
  await serviceRpc(ports, "agency_onboarding_mark_notified", { p_onboarding: onboardingId, p_kind: "staff_notified_references", p_detail: { to } }).catch(() => undefined);
  return { notified: true };
}

/** After a link holder's signature completed a request of an onboarding: the referee checks after the form, the staff email after the second referee, the "ready to activate" email after the agreement. */
export async function afterCompletion(ctx: Pick<OnboardingContext, "ports" | "store" | "fileBytes" | "commit">, plan: { id: string; kind?: string }): Promise<void> {
  if (plan.kind === "application") await sendRefereeChecks(ctx, plan.id);
  else if (plan.kind === "referee") await notifyReferencesReceived(ctx, plan.id);
  // The signed agreement activates nothing (2026-11-19): staff are told the business is ready; an administrator activates it.
  else if (plan.kind === "agreement") await notifyBusinessReady(ctx, plan.id);
}

const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * A new one-time link for an invitation, mailed through the signing mail provider; the database keeps only the token's hash. The link is
 * our own page (/agency/accept-invite#t=…): the token is checked only when the person presses the button there, so a mail scanner that
 * opens the link does not use it up. A later resend issues a new token and the old link stops working.
 * kind "business": the POC at activation; "member": an agent added to the business (their invitation was held until activation).
 */
export async function sendSetPasswordEmail(ports: SigningPorts, inv: { invitationId: string; email: string; name: string; role: string; agencyName: string; expiresAt: string | null; kind?: "business" | "member" }): Promise<boolean> {
  const { provider, config } = ports.mail;
  if (!provider || !config.from || !config.siteUrl) return false;
  const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256Hex(new TextEncoder().encode(token));
  await serviceRpc(ports, "portal_invitation_link_issue", { p_invitation: inv.invitationId, p_token_hash: hash });
  const link = `${config.siteUrl.replace(/\/+$/, "")}/agency/accept-invite#t=${token}`;
  const role = inv.role === "agency_admin" ? "the business admin agent" : "an agent";
  const until = inv.expiresAt && isoToday() <= inv.expiresAt.slice(0, 10) ? ` This link works until ${inv.expiresAt.slice(0, 10).split("-").reverse().join("/")}.` : "";
  const member = inv.kind === "member";
  const outcome = outcomeState(await provider.send({ deliveryId: `onboarding-activation-${inv.invitationId}-${hash.slice(0, 8)}`, from: config.from, to: inv.email,
    subject: member ? `Your Skyline agent portal sign-in for ${text(inv.agencyName, 100)}` : "Set your password for the Skyline agent portal",
    textBody: `Hello ${text(inv.name, 80) || "there"},\n\n`
      + (member ? `You have been added as ${role} of ${text(inv.agencyName, 120)} in the Skyline Institute of Technology agent portal.\n\n`
        : `Your agent agreement with Skyline Institute of Technology is signed and ${text(inv.agencyName, 120)} is now active. You are ${role} for it.\n\n`)
      + `Set your password to open the agent portal:\n${link}\n\nOpen the link and press the button on the page to continue.${until} If the link has expired, the page lets you ask for a new one.` + SIGN_OFF }));
  return outcome.state === "sent";
}

/** Business page: the references are rejected; the onboarding is declined (reason for staff only), its open requests voided, the agent told politely. */
export async function rejectOnboarding(ctx: OnboardingContext): Promise<Json> {
  await ctx.admin("subject_search", null, { type: "none" });
  const onboardingId = String(ctx.body.onboardingId ?? "");
  if (!UUID.test(onboardingId)) throw new SigningError("Choose an onboarding.");
  const declined = await ctx.rpc("agency_onboarding_decline", { p_onboarding: onboardingId, p_reason: text(ctx.body.reason, 1000) }) as
    { id: string; stage: string; kind?: "business" | "agent"; openRequestIds: string[]; agent: { id: string; name: string; email: string }; agency: { id: string; name: string } };
  for (const id of declined.openRequestIds ?? []) { try { await ctx.admin("void", id, { reason: "Onboarding declined" }); } catch { /* already closed */ } }
  const { provider, config } = ctx.ports.mail;
  let emailed = false;
  if (provider && config.from && declined.agent?.email) {
    const outcome = outcomeState(await provider.send({ deliveryId: `onboarding-declined-${onboardingId}`, from: config.from, to: declined.agent.email, subject: "Your agent application with Skyline Institute of Technology",
      textBody: declined.kind === "agent"
        ? `Hello ${text(declined.agent.name, 80) || "there"},\n\nThank you for your interest in becoming an agent for Skyline Institute of Technology with ${text(declined.agency.name, 120)}, and for the time you put into your application. `
          + "After reviewing it, we are unable to proceed at this time.\n\nWe appreciate your interest and wish you every success." + SIGN_OFF
        : `Hello ${text(declined.agent.name, 80) || "there"},\n\nThank you for your interest in representing Skyline Institute of Technology and for the time you put into the application for ${text(declined.agency.name, 120)}. `
        + "After reviewing it, we are unable to proceed with an agent agreement at this time.\n\nWe appreciate your interest and wish you every success. If you have any questions, please reply to this email." + SIGN_OFF }));
    emailed = outcome.state === "sent";
  }
  return { ...declined, emailed };
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
  agent_onboarding_reject: rejectOnboarding,
  agent_onboarding_referee_change: changeReferee,
  agent_onboarding_referee_upload: uploadRefereeForm,
  agent_onboarding_business_create: createBusiness,
  agent_onboarding_business_activate: activateBusinessByAdmin,
  agent_onboarding_abn_lookup: abnLookup,
  // Retired (2026-11-19): agents have no onboarding of their own.
  agent_onboarding_add_agent: retired,
  agent_onboarding_agent_activate: retired,
  agent_onboarding_agent_agreement_send: retired,
  agent_onboarding_agent_agreement_upload: retired,
  agent_onboarding_agent_countersigner_change: retired,
};
