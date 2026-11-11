// Cliente da Comanda10 Integrator API. É a parte para copiar para o seu sistema: cuida do vínculo OAuth,
// da renovação de tokens por estabelecimento, dos limites de requisição e dos erros da API.

const DEFAULT_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_RATE_LIMIT_RETRIES = 2;

export class Comanda10ApiError extends Error {
    constructor(status, body) {
        super(body?.error?.message ?? `HTTP ${status}`);
        this.name = 'Comanda10ApiError';
        this.status = status;
        this.code = body?.error?.code ?? 'UNKNOWN';
        this.body = body;
    }
}

/**
 * @typedef {object} MerchantTokens
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {number} expiresAt Instante, em milissegundos, em que o accessToken expira.
 */

/**
 * @typedef {object} TokenStore Onde o seu sistema guarda os tokens de cada estabelecimento.
 * @property {(merchantId: string) => Promise<MerchantTokens | undefined>} get
 * @property {(merchantId: string, tokens: MerchantTokens) => Promise<void>} save
 * @property {(merchantId: string, reason: string) => Promise<void>} markDisconnected
 */

export class Comanda10Client {
    #renewals = new Map();

    /**
     * @param {object} options
     * @param {string} options.apiUrl Endereço da API (Sandbox ou Production).
     * @param {string} options.clientId
     * @param {string} options.clientSecret Fica só no servidor.
     * @param {TokenStore} options.tokenStore
     * @param {typeof fetch} [options.fetch]
     * @param {(entry: object) => void} [options.onRequest] Recebe cada chamada feita, para log.
     */
    constructor({ apiUrl, clientId, clientSecret, tokenStore, fetch = globalThis.fetch, onRequest = () => {} }) {
        this.apiUrl = apiUrl.replace(/\/$/, '');
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.tokenStore = tokenStore;
        this.fetch = fetch;
        this.onRequest = onRequest;
        this.refreshMarginMs = DEFAULT_REFRESH_MARGIN_MS;
        this.rateLimitRetries = DEFAULT_RATE_LIMIT_RETRIES;
    }

    // ---- Vínculo com o estabelecimento ----

    /** Passo 1: gera o código que o estabelecimento aprova no gestão. Guarde o verifier no servidor. */
    async requestUserCode() {
        return this.#send('POST', '/oauth/userCode', { form: { clientId: this.clientId } });
    }

    /** Passo 3: troca o código que o estabelecimento colou pelos tokens e guarda pelo merchantId. */
    async exchangeAuthorizationCode({ authorizationCode, authorizationCodeVerifier }) {
        const tokens = await this.#send('POST', '/oauth/token', {
            form: {
                grantType: 'authorization_code',
                clientId: this.clientId,
                clientSecret: this.clientSecret,
                authorizationCode,
                authorizationCodeVerifier,
            },
        });

        await this.#saveTokens(tokens.merchantId, tokens);

        return tokens.merchantId;
    }

    // ---- Rotas do estabelecimento ----

    getMerchant(merchantId) {
        return this.request(merchantId, 'GET', `/v1/merchants/${merchantId}`);
    }

    getCatalog(merchantId) {
        return this.request(merchantId, 'GET', `/v1/merchants/${merchantId}/catalog`);
    }

    getItem(merchantId, itemId) {
        return this.request(merchantId, 'GET', `/v1/merchants/${merchantId}/items/${itemId}`);
    }

    listOrders(merchantId, { updatedSince, cursor, limit } = {}) {
        return this.request(merchantId, 'GET', `/v1/merchants/${merchantId}/orders`, {
            query: { updatedSince, cursor, limit },
        });
    }

    getOrder(merchantId, orderId) {
        return this.request(merchantId, 'GET', `/v1/merchants/${merchantId}/orders/${orderId}`);
    }

    searchOrderKpis(merchantId, query) {
        return this.request(merchantId, 'POST', `/v1/merchants/${merchantId}/orders/kpis`, { json: query });
    }

    /**
     * Chama uma rota /v1 com o token do estabelecimento. Renova o token antes de expirar e, uma vez, depois de
     * um 401. Um 403, ou uma renovação recusada, encerra o vínculo: só um novo vínculo devolve o acesso.
     */
    async request(merchantId, method, path, { query, json } = {}) {
        try {
            return await this.#requestWithFreshToken(merchantId, method, path, { query, json });
        } catch (error) {
            if (error instanceof Comanda10ApiError && error.status === 403) {
                await this.tokenStore.markDisconnected(merchantId, 'O estabelecimento revogou o vínculo.');
            }

            throw error;
        }
    }

    async #requestWithFreshToken(merchantId, method, path, { query, json }) {
        let tokens = await this.#tokensFor(merchantId);

        if (Date.now() >= tokens.expiresAt - this.refreshMarginMs) {
            tokens = await this.renewTokens(merchantId);
        }

        try {
            return await this.#send(method, path, { query, json, accessToken: tokens.accessToken });
        } catch (error) {
            if (!(error instanceof Comanda10ApiError) || error.status !== 401) throw error;

            tokens = await this.renewTokens(merchantId);

            return this.#send(method, path, { query, json, accessToken: tokens.accessToken });
        }
    }

    /**
     * Cada renovação invalida o refreshToken anterior. Por isso, renovações simultâneas do mesmo
     * estabelecimento compartilham uma única chamada: a segunda usaria um refreshToken que já não vale.
     */
    renewTokens(merchantId) {
        if (!this.#renewals.has(merchantId)) {
            const renewal = this.#renew(merchantId).finally(() => this.#renewals.delete(merchantId));
            this.#renewals.set(merchantId, renewal);
        }

        return this.#renewals.get(merchantId);
    }

    async #renew(merchantId) {
        const current = await this.#tokensFor(merchantId);

        try {
            const tokens = await this.#send('POST', '/oauth/token', {
                form: {
                    grantType: 'refresh_token',
                    clientId: this.clientId,
                    clientSecret: this.clientSecret,
                    refreshToken: current.refreshToken,
                },
            });

            return await this.#saveTokens(merchantId, tokens);
        } catch (error) {
            if (error instanceof Comanda10ApiError && error.status === 401) {
                await this.tokenStore.markDisconnected(
                    merchantId,
                    'O refreshToken expirou ou o vínculo foi revogado. Refaça o vínculo.',
                );
            }

            throw error;
        }
    }

    async #tokensFor(merchantId) {
        const tokens = await this.tokenStore.get(merchantId);

        if (!tokens) {
            throw new Comanda10ApiError(401, {
                error: { code: 'UNAUTHORIZED', message: 'Estabelecimento sem vínculo neste sistema.' },
            });
        }

        return tokens;
    }

    async #saveTokens(merchantId, { accessToken, refreshToken, expiresIn }) {
        const tokens = { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 };

        await this.tokenStore.save(merchantId, tokens);

        return tokens;
    }

    async #send(method, path, { form, json, query, accessToken } = {}, attempt = 0) {
        const url = new URL(`${this.apiUrl}${path}`);

        Object.entries(query ?? {}).forEach(([key, value]) => {
            if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        });

        const started = Date.now();
        const response = await this.fetch(url, {
            method,
            headers: {
                Accept: 'application/json',
                ...(form && { 'Content-Type': 'application/x-www-form-urlencoded' }),
                ...(json && { 'Content-Type': 'application/json' }),
                ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
            },
            body: form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : undefined,
        });
        const text = await response.text();
        const body = text ? JSON.parse(text) : undefined;

        this.onRequest({ method, path, status: response.status, ms: Date.now() - started, error: body?.error });

        if (response.status === 429 && attempt < this.rateLimitRetries) {
            const waitSeconds = Number(response.headers.get('Retry-After') ?? 1);

            await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));

            return this.#send(method, path, { form, json, query, accessToken }, attempt + 1);
        }

        if (!response.ok) {
            throw new Comanda10ApiError(response.status, body);
        }

        return body;
    }
}
