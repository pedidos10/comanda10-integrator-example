import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Comanda10ApiError, Comanda10Client } from '../src/comanda10Client.js';

const MERCHANT = 'dbc7e35a-c936-4665-9e13-eb55eb8b6824';
const HOUR_MS = 60 * 60 * 1000;

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });

/** Fake da API: responde pela rota e registra as chamadas. */
const fakeApi = handlers => {
    const calls = [];
    const fetch = async (url, init) => {
        const { pathname } = new URL(url);
        const body = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : undefined;
        calls.push({ method: init.method, pathname, body, authorization: init.headers.Authorization });

        return handlers[`${init.method} ${pathname}`](body, calls.length);
    };

    return { fetch, calls };
};

const memoryTokenStore = initial => {
    const tokens = new Map(initial ? [[MERCHANT, initial]] : []);
    const disconnected = new Map();

    return {
        tokens,
        disconnected,
        get: async id => tokens.get(id),
        save: async (id, value) => void tokens.set(id, value),
        markDisconnected: async (id, reason) => {
            tokens.delete(id);
            disconnected.set(id, reason);
        },
    };
};

const newClient = (fetch, tokenStore) =>
    new Comanda10Client({ apiUrl: 'https://api.test', clientId: 'client', clientSecret: 'secret', tokenStore, fetch });

const tokensResponse = (suffix = '2') =>
    json(200, {
        accessToken: `access-${suffix}`,
        refreshToken: `refresh-${suffix}`,
        merchantId: MERCHANT,
        type: 'bearer',
        expiresIn: 43200,
    });

describe('Comanda10Client', () => {
    it('should exchange the authorization code and keep the tokens by merchant', async () => {
        const store = memoryTokenStore();
        const api = fakeApi({ 'POST /oauth/token': () => tokensResponse('1') });

        const merchantId = await newClient(api.fetch, store).exchangeAuthorizationCode({
            authorizationCode: 'K7MQ-2XRP',
            authorizationCodeVerifier: 'verifier',
        });

        assert.equal(merchantId, MERCHANT);
        assert.equal(store.tokens.get(MERCHANT).accessToken, 'access-1');
        assert.deepEqual(api.calls[0].body, {
            grantType: 'authorization_code',
            clientId: 'client',
            clientSecret: 'secret',
            authorizationCode: 'K7MQ-2XRP',
            authorizationCodeVerifier: 'verifier',
        });
    });

    it('should renew the token before it expires', async () => {
        const store = memoryTokenStore({ accessToken: 'old', refreshToken: 'refresh-1', expiresAt: Date.now() + 1000 });
        const api = fakeApi({
            'POST /oauth/token': () => tokensResponse(),
            [`GET /v1/merchants/${MERCHANT}`]: () => json(200, { id: MERCHANT }),
        });

        await newClient(api.fetch, store).getMerchant(MERCHANT);

        assert.deepEqual(
            api.calls.map(call => call.pathname),
            ['/oauth/token', `/v1/merchants/${MERCHANT}`],
        );
        assert.equal(api.calls[1].authorization, 'Bearer access-2');
    });

    it('should renew once and retry after a 401', async () => {
        const store = memoryTokenStore({ accessToken: 'old', refreshToken: 'refresh-1', expiresAt: Date.now() + HOUR_MS });
        const api = fakeApi({
            'POST /oauth/token': () => tokensResponse(),
            [`GET /v1/merchants/${MERCHANT}`]: (_body, n) =>
                n === 1 ? json(401, { error: { code: 'UNAUTHORIZED', message: 'Token expirado' } }) : json(200, {}),
        });

        await newClient(api.fetch, store).getMerchant(MERCHANT);

        assert.equal(api.calls.length, 3);
        assert.equal(store.tokens.get(MERCHANT).refreshToken, 'refresh-2');
    });

    it('should share one renewal between concurrent calls, since each renewal voids the previous refresh token', async () => {
        const store = memoryTokenStore({ accessToken: 'old', refreshToken: 'refresh-1', expiresAt: Date.now() });
        const api = fakeApi({
            'POST /oauth/token': () => tokensResponse(),
            [`GET /v1/merchants/${MERCHANT}`]: () => json(200, {}),
            [`GET /v1/merchants/${MERCHANT}/catalog`]: () => json(200, {}),
        });
        const client = newClient(api.fetch, store);

        await Promise.all([client.getMerchant(MERCHANT), client.getCatalog(MERCHANT)]);

        assert.equal(api.calls.filter(call => call.pathname === '/oauth/token').length, 1);
    });

    it('should wait Retry-After and try again on 429', async () => {
        const store = memoryTokenStore({ accessToken: 'ok', refreshToken: 'r', expiresAt: Date.now() + HOUR_MS });
        const api = fakeApi({
            [`GET /v1/merchants/${MERCHANT}`]: (_body, n) =>
                n === 1 ? json(429, { error: { code: 'RATE_LIMITED' } }, { 'Retry-After': '0' }) : json(200, { ok: true }),
        });

        assert.deepEqual(await newClient(api.fetch, store).getMerchant(MERCHANT), { ok: true });
        assert.equal(api.calls.length, 2);
    });

    it('should mark the merchant disconnected when the link is revoked', async () => {
        const store = memoryTokenStore({ accessToken: 'ok', refreshToken: 'r', expiresAt: Date.now() + HOUR_MS });
        const api = fakeApi({
            [`GET /v1/merchants/${MERCHANT}`]: () => json(403, { error: { code: 'FORBIDDEN', message: 'Revogado' } }),
        });

        await assert.rejects(newClient(api.fetch, store).getMerchant(MERCHANT), error => {
            assert.ok(error instanceof Comanda10ApiError);
            assert.equal(error.code, 'FORBIDDEN');
            return true;
        });
        assert.ok(store.disconnected.has(MERCHANT));
        assert.equal(store.tokens.has(MERCHANT), false);
    });

    it('should mark the merchant disconnected when the renewal is refused', async () => {
        const store = memoryTokenStore({ accessToken: 'old', refreshToken: 'used', expiresAt: Date.now() });
        const api = fakeApi({
            'POST /oauth/token': () => json(401, { error: { code: 'UNAUTHORIZED', message: 'Refresh token inválido' } }),
        });

        await assert.rejects(newClient(api.fetch, store).getMerchant(MERCHANT), { code: 'UNAUTHORIZED' });
        assert.ok(store.disconnected.has(MERCHANT));
    });
});
