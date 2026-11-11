// Sincronização incremental de pedidos, na receita da documentação (seção Paginação).
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LOOKBACK_DAYS = 30;
// Folga para diferenças de relógio entre o seu servidor e a API: pedidos repetidos são normais.
const CLOCK_MARGIN_MS = 5 * 60 * 1000;

/**
 * 1. Anota o instante em que a rodada começa.
 * 2. Pede os pedidos com atividade desde o instante guardado na rodada anterior.
 * 3. Segue nextCursor até o fim, gravando cada pedido pelo id.
 * 4. Só então guarda o instante novo, menos a folga.
 */
export async function syncOrders({ client, store, merchantId, initialSyncDays = 1, now = Date.now }) {
    const merchant = store.ensureMerchant(merchantId);
    const startedAt = now();
    const firstRunDays = Math.min(initialSyncDays, MAX_LOOKBACK_DAYS);
    const updatedSince = merchant.ordersCheckpoint ?? new Date(startedAt - firstRunDays * DAY_MS).toISOString();
    let cursor;
    let pages = 0;
    let received = 0;

    do {
        const page = await client.listOrders(merchantId, { updatedSince, cursor, limit: 100 });

        page.data.forEach(order => {
            merchant.orders[order.id] = order;
        });
        received += page.data.length;
        cursor = page.nextCursor;
        pages += 1;
    } while (cursor);

    merchant.ordersCheckpoint = new Date(startedAt - CLOCK_MARGIN_MS).toISOString();
    await store.flush();

    return { pages, received, updatedSince, total: Object.keys(merchant.orders).length };
}
