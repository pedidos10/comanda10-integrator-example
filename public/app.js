const $ = id => document.getElementById(id);
const money = value => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const escapeHtml = text => String(text ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let state = { pendingLinks: [], merchants: [], log: [] };
let catalog = null;
let activeService = null;

async function api(method, path, body) {
    const response = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message ?? `HTTP ${response.status}`);
    return data;
}

async function refreshState() {
    state = await api('GET', '/api/state');
    $('baseUrl').textContent = state.baseUrl;
    $('clientId').textContent = state.clientId;
    renderPending();
    renderMerchants();
    renderLog();
}

function renderPending() {
    $('pendingLinks').innerHTML = state.pendingLinks
        .map(link => {
            const secondsLeft = Math.max(0, Math.round((link.expiresAt - Date.now()) / 1000));
            return `
            <div class="pending">
                <div class="muted">Peça ao estabelecimento para informar este código no gestão
                    ${secondsLeft ? `(expira em ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')})` : '(expirado)'}</div>
                <div class="code">${link.userCode}</div>
                <div class="row">
                    <a href="${link.verificationUrlComplete}" target="_blank">Abrir link de aprovação ↗</a>
                    <button class="secondary" onclick="navigator.clipboard.writeText('${link.verificationUrlComplete}')">Copiar link</button>
                </div>
                <div class="row">
                    <input type="text" id="auth-${link.userCode}" placeholder="Código de autorização" maxlength="9" />
                    <button onclick="completeLink('${link.userCode}')">Concluir</button>
                </div>
                <div class="row"><button class="danger" onclick="discardLink('${link.userCode}')">Descartar</button></div>
            </div>`;
        })
        .join('');
}

function renderMerchants() {
    if (!state.merchants.length) {
        $('merchants').innerHTML = 'Nenhum ainda.';
        return;
    }
    $('merchants').innerHTML = state.merchants
        .map(merchant => {
            const expiresIn = Math.round((merchant.accessExpiresAt - Date.now()) / 60000);
            const ok = merchant.connected;
            return `
            <div class="merchant">
                <strong>${escapeHtml(merchant.name ?? 'Estabelecimento')}</strong>
                <div class="muted"><code>${merchant.merchantId}</code></div>
                <div class="muted">${!ok ? 'Sem token' : expiresIn > 0 ? `Token expira em ${expiresIn} min` : 'Token expirado (renova sozinho)'}
                    · <span class="badge ${ok ? '' : 'bad'}">${escapeHtml(merchant.status)}</span></div>
                <div class="row">
                    <button onclick="loadCatalog('${merchant.merchantId}')">Ver cardápio</button>
                    <button onclick="openOrders('${merchant.merchantId}')">Pedidos (${merchant.ordersCount ?? 0})</button>
                    <button onclick="openKpis('${merchant.merchantId}')">Indicadores</button>
                    <button class="secondary" onclick="refreshToken('${merchant.merchantId}')">Renovar token</button>
                    <button class="danger" onclick="forget('${merchant.merchantId}')">Remover</button>
                </div>
            </div>`;
        })
        .join('');
}

function renderLog() {
    $('log').innerHTML = state.log
        .map(
            entry => `<tr>
                <td>${new Date(entry.at).toLocaleTimeString('pt-BR')}</td>
                <td>${entry.method}</td>
                <td><code>${escapeHtml(entry.path)}</code></td>
                <td class="s${String(entry.status)[0]}">${entry.status}</td>
                <td>${entry.ms}</td>
                <td>${escapeHtml(entry.error ? `${entry.error.code}: ${entry.error.message}` : '')}</td>
            </tr>`,
        )
        .join('');
}

const SERVICE_LABEL = { INDOOR: 'Salão', TAKEOUT: 'Balcão', DELIVERY: 'Delivery' };

function renderCatalog() {
    if (!catalog) return;
    if ($('rawToggle').checked) {
        $('catalog').innerHTML = `<pre>${escapeHtml(JSON.stringify(catalog, null, 2))}</pre>`;
        return;
    }

    const service = catalog.services.find(item => item.serviceType === activeService) ?? catalog.services[0];
    activeService = service?.serviceType;
    const menu = catalog.menus.find(item => item.id === service?.menuId);
    const byId = list => Object.fromEntries((list ?? []).map(item => [item.id, item]));
    const items = byId(catalog.items);
    const offers = byId(catalog.itemOffers);
    const groups = byId(catalog.optionGroups);
    const categories = byId(catalog.categories);

    const hours = (service?.serviceHours.weekHours ?? [])
        .map(h => `${h.dayOfWeek.map(d => d.slice(0, 3)).join(', ')} ${h.timePeriods.startTime.slice(0, 5)}–${h.timePeriods.endTime.slice(0, 5)}`)
        .join(' · ');

    const tabs = catalog.services
        .map(item => `<button class="${item.serviceType === activeService ? 'active' : ''}" onclick="selectService('${item.serviceType}')">${SERVICE_LABEL[item.serviceType] ?? item.serviceType}</button>`)
        .join('');

    const body = (menu?.categoryId ?? [])
        .map(categoryId => {
            const category = categories[categoryId];
            const rows = (category.itemOfferId ?? [])
                .map(offerId => {
                    const offer = offers[offerId];
                    const item = items[offer.itemId];
                    const optionGroups = (offer.optionGroupsId ?? [])
                        .map(groupId => {
                            const group = groups[groupId];
                            const options = (group.options ?? [])
                                .map(option => `${escapeHtml(items[option.itemId]?.name)} ${money(option.price?.value ?? 0)}`)
                                .join(', ');
                            return `<div class="group"><b>${escapeHtml(group.name)}</b> (${group.minPermitted}–${group.maxPermitted}, ${group.priceMethod}): ${options}</div>`;
                        })
                        .join('');
                    return `
                    <div class="item ${offer.status === 'UNAVAILABLE' ? 'unavailable' : ''}">
                        <img src="${item.image?.URL ?? ''}" alt="" onerror="this.style.visibility='hidden'" />
                        <div class="info">
                            <strong><a href="#" onclick="showItem('${item.id}'); return false;">${escapeHtml(item.name)}</a></strong> <span class="muted">${item.unit} · ${escapeHtml(item.externalCode)}</span>
                            ${offer.status === 'UNAVAILABLE' ? '<span class="badge bad">esgotado</span>' : ''}
                            ${offer.availabilityId?.length ? '<span class="badge">horário restrito</span>' : ''}
                            <div class="muted">${escapeHtml(item.description)}</div>
                            ${optionGroups}
                        </div>
                        <div class="price">${offer.price.value ? money(offer.price.value) : 'a partir das opções'}</div>
                    </div>`;
                })
                .join('');
            return `<div class="category"><h3>${escapeHtml(category.name)}</h3>${rows}</div>`;
        })
        .join('');

    $('catalog').innerHTML = `
        <div class="tabs">${tabs}</div>
        <div class="muted">Horário: ${hours || 'não cadastrado'} · TTL ${catalog.TTL}s · atualizado ${new Date(catalog.lastUpdate).toLocaleString('pt-BR')}</div>
        ${body || '<p class="muted">Menu vazio neste canal.</p>'}`;
}

window.showItem = async itemId => {
    $('catalog').innerHTML = 'Carregando item…';
    try {
        const detail = await api('GET', `/api/merchants/item?merchantId=${catalog.merchantId}&itemId=${itemId}`);
        $('catalog').innerHTML = `
            <button onclick="renderCatalog()">← Voltar ao cardápio</button>
            <p class="muted">GET /v1/merchants/{merchantId}/items/${escapeHtml(itemId)}</p>
            <pre>${escapeHtml(JSON.stringify(detail, null, 2))}</pre>`;
    } catch (error) {
        $('catalog').innerHTML = `<button onclick="renderCatalog()">← Voltar</button><p class="badge bad">${escapeHtml(error.message)}</p>`;
    }
};

window.renderCatalog = renderCatalog;

window.selectService = serviceType => {
    activeService = serviceType;
    renderCatalog();
};

window.loadCatalog = async merchantId => {
    $('catalog').innerHTML = 'Carregando…';
    try {
        catalog = await api('GET', `/api/merchants/catalog?merchantId=${merchantId}`);
        $('catalogTitle').textContent = `Cardápio · ${catalog.basicInfo.name}`;
        renderCatalog();
    } catch (error) {
        $('catalog').innerHTML = `<p class="badge bad">${escapeHtml(error.message)}</p>`;
    }
    refreshState();
};

window.completeLink = async userCode => {
    const authorizationCode = $(`auth-${userCode}`).value.trim();
    if (!authorizationCode) return;
    try {
        const merchant = await api('POST', '/api/links/complete', { userCode, authorizationCode });
        await refreshState();
        loadCatalog(merchant.merchantId);
    } catch (error) {
        alert(error.message);
        refreshState();
    }
};

window.discardLink = async userCode => {
    await api('DELETE', `/api/links?userCode=${userCode}`);
    refreshState();
};

window.refreshToken = async merchantId => {
    try {
        await api('POST', '/api/merchants/refresh', { merchantId });
    } catch (error) {
        alert(error.message);
    }
    refreshState();
};

window.forget = async merchantId => {
    await api('DELETE', `/api/merchants?merchantId=${merchantId}`);
    refreshState();
};

$('startLink').onclick = async () => {
    try {
        await api('POST', '/api/links');
    } catch (error) {
        alert(error.message);
    }
    refreshState();
};

$('rawToggle').onchange = renderCatalog;

refreshState();
setInterval(() => {
    if (document.activeElement?.tagName !== 'INPUT') refreshState();
}, 3000);

let ordersMerchantId = null;
const openOrderIds = new Set();
const EVENT_LABEL = {
    CREATED: 'Criado',
    CONFIRMED: 'Confirmado',
    READY_FOR_PICKUP: 'Pronto',
    DISPATCHED: 'Saiu p/ entrega',
    DELIVERED: 'Entregue',
    CONCLUDED: 'Concluído',
    CANCELLED: 'Cancelado',
};
const TYPE_LABEL = { INDOOR: 'Salão', TAKEOUT: 'Balcão', DELIVERY: 'Delivery' };

function orderDetails(order) {
    const items = order.items
        .map(item => {
            const options = (item.options ?? [])
                .map(option => `${option.groupName ? `${escapeHtml(option.groupName)}: ` : ''}${escapeHtml(option.name)}${option.fraction ? ` (${Math.round(option.fraction * 100)}%)` : ''}${option.totalPrice.value ? ` +${money(option.totalPrice.value)}` : ''}`)
                .join('; ');
            return `<tr><td>${item.quantity}× ${escapeHtml(item.name)}${options ? `<div class="muted">${options}</div>` : ''}${item.specialInstructions ? `<div class="muted">obs: ${escapeHtml(item.specialInstructions)}</div>` : ''}</td><td>${money(item.totalPrice.value)}</td></tr>`;
        })
        .join('');
    const fees = (order.otherFees ?? []).map(fee => `<tr><td>${escapeHtml(fee.name)}</td><td>${money(fee.price.value)}</td></tr>`).join('');
    const methods = order.payments.methods
        .map(method => `${method.method}${method.brand ? ` ${method.brand}` : ''} ${money(method.value)} (${method.type})`)
        .join(', ');
    const where = order.indoor
        ? `Mesa ${escapeHtml(order.indoor.place ?? '-')} · comanda ${escapeHtml(order.indoor.tab ?? '-')} · garçom ${escapeHtml(order.indoor.waiterCode ?? '-')}`
        : order.delivery
          ? `Entrega: ${escapeHtml(order.delivery.deliveryAddress.formattedAddress)}`
          : 'Retirada no balcão';
    return `
        <div class="muted">${where}${order.customer ? ` · cliente ${escapeHtml(order.customer.name)}` : ''}</div>
        <table>${items}${fees}
            ${order.total.discount.value ? `<tr><td>Desconto</td><td>-${money(order.total.discount.value)}</td></tr>` : ''}
            <tr><td><b>Total</b></td><td><b>${money(order.total.orderAmount.value)}</b></td></tr>
        </table>
        <div class="muted">Pagamentos: ${methods || 'nenhum'} · pago ${money(order.payments.prepaid)} · pendente ${money(order.payments.pending)} · NFC-e ${order.taxInvoice?.issued ? 'emitida' : 'não emitida'}</div>
        <div class="row"><button class="secondary" onclick="event.stopPropagation(); refetchOrder('${order.id}')">Buscar de novo (GET /orders/{id})</button></div>`;
}

async function renderOrders() {
    if (!ordersMerchantId) return;
    const { orders, ordersSyncedAt } = await api('GET', `/api/merchants/orders?merchantId=${ordersMerchantId}`);
    $('syncInfo').textContent = ordersSyncedAt
        ? `Próximo updatedSince: ${new Date(ordersSyncedAt).toLocaleString('pt-BR')} · ${orders.length} pedidos na cópia local`
        : 'Ainda não sincronizado (a primeira rodada volta initialSyncDays do config.json).';
    $('orders').innerHTML = orders.length
        ? orders
              .map(
                  order => `
            <div class="order ${openOrderIds.has(order.id) ? 'open' : ''}" onclick="toggleOrder('${order.id}')">
                <div class="head">
                    <div><b>#${escapeHtml(order.displayId)}</b> · ${TYPE_LABEL[order.type] ?? order.type} · <span class="muted">${escapeHtml(order.salesChannel ?? '')} · ${new Date(order.createdAt).toLocaleString('pt-BR')}</span></div>
                    <div><span class="status ${order.lastEvent}">${EVENT_LABEL[order.lastEvent] ?? order.lastEvent}</span> <b>${money(order.total.orderAmount.value)}</b></div>
                </div>
                <div class="details">${orderDetails(order)}</div>
            </div>`,
              )
              .join('')
        : '<p class="muted">Nenhum pedido na cópia local. Clique em "Sincronizar".</p>';
}

window.toggleOrder = id => {
    openOrderIds.has(id) ? openOrderIds.delete(id) : openOrderIds.add(id);
    renderOrders();
};

window.refetchOrder = async id => {
    try {
        await api('GET', `/api/merchants/orders/detail?merchantId=${ordersMerchantId}&orderId=${id}`);
    } catch (error) {
        alert(error.message);
    }
    renderOrders();
    refreshState();
};

window.openOrders = async merchantId => {
    ordersMerchantId = merchantId;
    const merchant = state.merchants.find(item => item.merchantId === merchantId);
    $('ordersTitle').textContent = `Pedidos · ${merchant?.name ?? ''}`;
    $('syncOrders').disabled = false;
    $('resetOrders').disabled = false;
    await renderOrders();
};

async function syncOrders() {
    if (!ordersMerchantId) return;
    try {
        const result = await api('POST', '/api/merchants/orders/sync', { merchantId: ordersMerchantId });
        $('syncInfo').textContent = `Rodada: ${result.received} pedidos em ${result.pages} página(s) desde ${new Date(result.updatedSince).toLocaleString('pt-BR')}`;
    } catch (error) {
        alert(error.message);
    }
    await renderOrders();
    refreshState();
}

$('syncOrders').onclick = syncOrders;
$('resetOrders').onclick = async () => {
    await api('POST', '/api/merchants/orders/reset', { merchantId: ordersMerchantId });
    renderOrders();
    refreshState();
};
setInterval(() => {
    if ($('autoSync').checked) syncOrders();
}, 15000);

let kpiMerchantId = null;

window.openKpis = merchantId => {
    kpiMerchantId = merchantId;
    const merchant = state.merchants.find(item => item.merchantId === merchantId);
    $('kpiTitle').textContent = `Indicadores · ${merchant?.name ?? ''}`;
    $('loadKpis').disabled = false;
    loadKpis();
};

async function loadKpis() {
    if (!kpiMerchantId) return;
    const days = Number($('kpiDays').value);
    const group = $('kpiGroup').value;
    const now = new Date();
    const query = {
        filter: {
            referenceDate: { gte: new Date(now - days * 864e5).toISOString(), lte: now.toISOString() },
            ...($('kpiConcluded').checked && { orderStatus: ['CONCLUDED'] }),
        },
        agg: {
            ...(group && { groupBy: { fields: [group] } }),
            metrics: {
                gmv: ['sum', 'avg'],
                feesGrossValue: ['sum'],
                benefitByTypePartnerTotalValue: ['sum'],
                paymentTotalValue: ['sum'],
                occupants: ['sum'],
            },
        },
        sort: { groupByKey: 'asc' },
    };
    $('kpis').innerHTML = 'Consultando…';
    try {
        const result = await api('POST', '/api/merchants/kpis', { merchantId: kpiMerchantId, query });
        const totals = result.data.reduce(
            (acc, row) => ({ orders: acc.orders + row.groupByKey.count, gmv: acc.gmv + (row.gmv?.sum ?? 0) }),
            { orders: 0, gmv: 0 },
        );
        const rows = result.data
            .map(
                row => `<tr>
                    <td>${escapeHtml(group ? row.groupByKey.value[group] ?? '(sem valor)' : 'Todos')}</td>
                    <td>${row.groupByKey.count}</td>
                    <td>${money(row.gmv.sum)}</td>
                    <td>${money(row.gmv.avg)}</td>
                    <td>${money(row.feesGrossValue.sum)}</td>
                    <td>${money(row.benefitByTypePartnerTotalValue.sum)}</td>
                    <td>${money(row.paymentTotalValue.sum)}</td>
                    <td>${row.occupants.sum}</td>
                </tr>`,
            )
            .join('');
        $('kpis').innerHTML = `
            <div class="kpi-summary">
                <div>Pedidos<b>${group === 'paymentMethod' || group === 'category' ? '—' : totals.orders}</b></div>
                <div>Faturamento (GMV)<b>${group === 'paymentMethod' || group === 'category' ? '—' : money(totals.gmv)}</b></div>
                <div>Ticket médio<b>${totals.orders && group !== 'paymentMethod' && group !== 'category' ? money(totals.gmv / totals.orders) : '—'}</b></div>
            </div>
            ${group === 'paymentMethod' || group === 'category' ? '<div class="muted">Pedidos com mais de um valor entram em cada grupo, então os totais não somam.</div>' : ''}
            <table>
                <thead><tr><th>${escapeHtml($('kpiGroup').selectedOptions[0].text)}</th><th>Pedidos</th><th>GMV</th><th>Ticket médio</th><th>Taxas</th><th>Descontos</th><th>Pago</th><th>Pessoas</th></tr></thead>
                <tbody>${rows || '<tr><td colspan="8" class="muted">Nenhum pedido no período.</td></tr>'}</tbody>
            </table>`;
    } catch (error) {
        $('kpis').innerHTML = `<p class="badge bad">${escapeHtml(error.message)}</p>`;
    }
    refreshState();
}

$('loadKpis').onclick = loadKpis;
