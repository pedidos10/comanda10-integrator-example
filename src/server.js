// Backend da integradora de exemplo: guarda clientSecret, verifiers e tokens. O navegador nunca vê o secret.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';

import { Comanda10ApiError, Comanda10Client } from './comanda10Client.js';
import { config } from './config.js';
import { syncOrders } from './orderSync.js';
import { JsonStore } from './store.js';

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const requestLog = [];
const store = await new JsonStore(config.dataFile).load();
const client = new Comanda10Client({
    apiUrl: config.apiUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    tokenStore: store.tokenStore,
    onRequest: entry => {
        requestLog.unshift({ at: new Date().toISOString(), ...entry });
        requestLog.length = Math.min(requestLog.length, 100);
    },
});

const ok = body => ({ status: 200, body });
const notFound = message => ({ status: 404, body: { error: { code: 'NOT_FOUND', message } } });

const publicMerchant = ({ tokens, orders, ...merchant }) => ({
    ...merchant,
    connected: Boolean(tokens),
    accessExpiresAt: tokens?.expiresAt ?? null,
    ordersCount: Object.keys(orders ?? {}).length,
});

const routes = {
    'GET /api/state': async () =>
        ok({
            baseUrl: config.apiUrl,
            clientId: config.clientId,
            pendingLinks: Object.values(store.data.pendingLinks).map(({ verifier, ...link }) => link),
            merchants: Object.values(store.data.merchants).map(publicMerchant),
            log: requestLog,
        }),

    'POST /api/links': async () => {
        const code = await client.requestUserCode();

        store.data.pendingLinks[code.userCode] = {
            userCode: code.userCode,
            verifier: code.authorizationCodeVerifier,
            verificationUrlComplete: code.verificationUrlComplete,
            expiresAt: Date.now() + code.expiresIn * 1000,
        };
        await store.flush();

        return ok({ userCode: code.userCode, verificationUrlComplete: code.verificationUrlComplete });
    },

    'POST /api/links/complete': async ({ userCode, authorizationCode }) => {
        const pending = store.data.pendingLinks[userCode];

        if (!pending) return notFound('Código de vínculo não encontrado.');

        const merchantId = await client.exchangeAuthorizationCode({
            authorizationCode,
            authorizationCodeVerifier: pending.verifier,
        });
        const merchant = store.ensureMerchant(merchantId);

        merchant.name = (await client.getMerchant(merchantId)).basicInfo?.name;
        delete store.data.pendingLinks[userCode];
        await store.flush();

        return ok(publicMerchant(merchant));
    },

    'DELETE /api/links': async ({ userCode }) => {
        delete store.data.pendingLinks[userCode];
        await store.flush();

        return ok({});
    },

    'GET /api/merchants/catalog': async ({ merchantId }) => {
        const [merchant, catalog] = await Promise.all([
            client.getMerchant(merchantId),
            client.getCatalog(merchantId),
        ]);

        store.ensureMerchant(merchantId).name = merchant.basicInfo?.name;
        await store.flush();

        return ok({ ...merchant, ...catalog });
    },

    'GET /api/merchants/item': async ({ merchantId, itemId }) => ok(await client.getItem(merchantId, itemId)),

    'POST /api/merchants/refresh': async ({ merchantId }) => {
        await client.renewTokens(merchantId);

        return ok(publicMerchant(store.merchant(merchantId)));
    },

    'DELETE /api/merchants': async ({ merchantId }) => {
        delete store.data.merchants[merchantId];
        await store.flush();

        return ok({});
    },

    'POST /api/merchants/orders/sync': async ({ merchantId }) =>
        ok(await syncOrders({ client, store, merchantId, initialSyncDays: config.initialSyncDays })),

    'GET /api/merchants/orders': async ({ merchantId }) => {
        const merchant = store.merchant(merchantId);

        if (!merchant) return notFound('Estabelecimento não vinculado.');

        const orders = Object.values(merchant.orders ?? {}).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

        return ok({ orders, ordersSyncedAt: merchant.ordersCheckpoint ?? null });
    },

    'GET /api/merchants/orders/detail': async ({ merchantId, orderId }) => {
        const order = await client.getOrder(merchantId, orderId);

        store.ensureMerchant(merchantId).orders[orderId] = order;
        await store.flush();

        return ok(order);
    },

    'POST /api/merchants/orders/reset': async ({ merchantId }) => {
        const merchant = store.ensureMerchant(merchantId);

        merchant.orders = {};
        merchant.ordersCheckpoint = undefined;
        await store.flush();

        return ok({});
    },

    'POST /api/merchants/kpis': async ({ merchantId, query }) => ok(await client.searchOrderKpis(merchantId, query)),
};

const readJson = async req => {
    const chunks = [];

    for await (const chunk of req) chunks.push(chunk);

    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
};

const serveStatic = async (pathname, res) => {
    const file = join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

    if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) {
        res.writeHead(404).end();
        return;
    }

    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
};

createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (!url.pathname.startsWith('/api/')) {
        await serveStatic(url.pathname, res);
        return;
    }

    const handler = routes[`${req.method} ${url.pathname}`];

    if (!handler) {
        res.writeHead(404).end();
        return;
    }

    let result;

    try {
        result = await handler({ ...Object.fromEntries(url.searchParams), ...(await readJson(req)) });
    } catch (error) {
        // Erros da API Comanda10 vão para a tela com o mesmo status e corpo.
        result =
            error instanceof Comanda10ApiError
                ? { status: error.status, body: error.body ?? { error: { message: error.message } } }
                : { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: error.message } } };
    }

    res.writeHead(result.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(result.body));
}).listen(config.port, () => {
    console.info(`Integradora Exemplo em http://localhost:${config.port} → ${config.apiUrl}`);
});
