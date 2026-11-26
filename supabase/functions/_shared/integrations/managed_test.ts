import assert from 'node:assert/strict';
import { probeManagedProvider } from './managed-probe.ts';
import { resolveManagedCredential, validateManagedFields } from './managed-runtime.ts';

Deno.test('managed credentials validate strictly and resolve only in the authorized scope', async () => {
  assert.equal(validateManagedFields('abr', { guid: 'unsupported' }), null);
  assert.equal(validateManagedFields('openai', { apiKey: 'synthetic', baseUrl: 'https://example.invalid' }), null);
  assert.equal(validateManagedFields('training_gov_au', { environment: 'production', username: 'u', password: 'p' }), null);
  const fields = { environment: 'sandbox', username: 'test-user', password: ' synthetic ' };
  assert.deepEqual(validateManagedFields('training_gov_au', fields), fields);
  const tenant = 'f0000000-0000-4000-8000-000000000001';
  for (const state of ['legacy', 'staged', 'disabled', 'active']) {
    const result = await resolveManagedCredential(async (name, args) => {
      assert.equal(name, 'integration_managed_runtime');
      assert.deepEqual(args, { p_tenant: tenant, p_provider: 'training_gov_au' });
      return { data: { state, credential: JSON.stringify({ version: 1, fields }) }, error: null };
    }, tenant, 'training_gov_au');
    const source = { legacy: 'legacy', staged: 'legacy', disabled: 'unavailable', active: 'central' }[state];
    assert.equal(result.source, source);
    if (result.source === 'central') assert.deepEqual(result.fields, fields);
  }
  const failed = await resolveManagedCredential(async () => ({ data: null, error: 'unavailable' }), tenant, 'training_gov_au');
  assert.deepEqual(failed, { source: 'unavailable' });
});

Deno.test('provider tests use fixed destinations, safe operations and bounded requests', async () => {
  const headers = new Headers();
  let calls = 0;
  const mock: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    for (const [key, value] of new Headers(init?.headers)) headers.set(key, value);
    switch (new URL(String(input)).hostname) {
      case 'api.openai.com':
        assert.equal(new URL(String(input)).pathname, '/v1/models');
        assert.equal(headers.get('authorization'), 'Bearer synthetic-secret');
        assert.equal(init?.method, undefined);
        return Response.json({ data: [] });
      case 'api.postmarkapp.com':
        assert.equal(new URL(String(input)).pathname, '/server');
        assert.equal(headers.get('x-postmark-server-token'), 'synthetic-secret');
        assert.equal(init?.method, undefined);
        return Response.json({ ApiTokens: ['synthetic-secret'] });
      case 'api.geoscape.com.au':
        assert.equal(headers.get('authorization'), 'synthetic-secret');
        return Response.json({ results: [] });
      case 'ws.sandbox.training.gov.au':
        assert.match(String(init?.body), /Username>synthetic-user</);
        assert.match(String(init?.body), /Password[^>]*>synthetic-secret</);
        return new Response('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><SearchResponse xmlns="http://training.gov.au/services/13/"><SearchResult><Results/></SearchResult></SearchResponse></s:Body></s:Envelope>');
      case 'abr.business.gov.au':
        return new Response('c({"Abn":"51824753556","AbnStatus":"Active","EntityName":"Synthetic validation"})');
      case 'data.gov.au':
        return Response.json({ success: true, result: { resources: [] } });
      case 'date.nager.at':
        return Response.json([{ date: '2026-01-01', countryCode: 'AU' }]);
      default:
        throw Error('Unexpected provider');
    }
  };
  assert.equal(await probeManagedProvider('openai', { apiKey: 'synthetic-secret' }, mock), 'verified');
  assert.equal(await probeManagedProvider('postmark', { token: 'synthetic-secret' }, mock), 'verified');
  assert.equal(await probeManagedProvider('geoscape', { apiKey: 'synthetic-secret' }, mock), 'verified');
  assert.equal(await probeManagedProvider('training_gov_au', { username: 'synthetic-user', password: 'synthetic-secret' }, mock), 'verified');
  assert.equal(await probeManagedProvider('abr', { guid: 'synthetic-secret' }, mock), 'verified');
  assert.equal(await probeManagedProvider('data_gov_au', {}, mock), 'verified');
  assert.equal(await probeManagedProvider('nager_date', {}, mock), 'verified');
  assert.equal(await probeManagedProvider('cloudflare_turnstile', {}, mock), 'format_only');
  assert.equal(calls, 7);
  assert.equal(await probeManagedProvider('postmark', {}, async () => new Response(null, { status: 401 })), 'invalid');
});
