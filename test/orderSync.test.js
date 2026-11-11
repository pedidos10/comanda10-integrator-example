import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { syncOrders } from '../src/orderSync.js';
import { JsonStore } from '../src/store.js';

const MERCHANT = 'dbc7e35a-c936-4665-9e13-eb55eb8b6824';
const NOW = Date.parse('2026-11-11T12:00:00Z');

const newStore = async () => new JsonStore(join(await mkdtemp(join(tmpdir(), 'sync-')), 'store.json')).load();

const pagedClient = pages => {
    const calls = [];

    return {
        calls,
        listOrders: async (_merchantId, params) => {
            calls.push(params);

            return pages[calls.length - 1];
        },
    };
};

describe('syncOrders', () => {
    it('should follow nextCursor, upsert by id and keep the round start minus 5 minutes', async () => {
        const store = await newStore();
        const client = pagedClient([
            { data: [{ id: 'a', createdAt: '1' }, { id: 'b', createdAt: '2' }], nextCursor: 'page-2' },
            { data: [{ id: 'a', createdAt: '1', lastEvent: 'CONCLUDED' }], nextCursor: null },
        ]);

        const result = await syncOrders({ client, store, merchantId: MERCHANT, initialSyncDays: 2, now: () => NOW });

        assert.equal(client.calls[0].updatedSince, '2026-11-09T12:00:00.000Z');
        assert.equal(client.calls[1].cursor, 'page-2');
        assert.equal(client.calls[1].updatedSince, client.calls[0].updatedSince);
        assert.deepEqual(result, { pages: 2, received: 3, updatedSince: '2026-11-09T12:00:00.000Z', total: 2 });
        assert.equal(store.merchant(MERCHANT).orders.a.lastEvent, 'CONCLUDED');
        assert.equal(store.merchant(MERCHANT).ordersCheckpoint, '2026-11-11T11:55:00.000Z');
    });

    it('should start the next round from the saved checkpoint', async () => {
        const store = await newStore();
        store.ensureMerchant(MERCHANT).ordersCheckpoint = '2026-11-11T11:55:00.000Z';
        const client = pagedClient([{ data: [], nextCursor: null }]);

        await syncOrders({ client, store, merchantId: MERCHANT, now: () => NOW });

        assert.equal(client.calls[0].updatedSince, '2026-11-11T11:55:00.000Z');
    });

    it('should not ask for more than the 30 days the API accepts', async () => {
        const store = await newStore();
        const client = pagedClient([{ data: [], nextCursor: null }]);

        await syncOrders({ client, store, merchantId: MERCHANT, initialSyncDays: 90, now: () => NOW });

        assert.equal(client.calls[0].updatedSince, '2026-10-12T12:00:00.000Z');
    });
});
