// Armazenamento local do exemplo, num arquivo JSON. No seu sistema, troque por um banco de dados: o formato
// que importa é o do TokenStore (get, save, markDisconnected), usado pelo Comanda10Client.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class JsonStore {
    constructor(file) {
        this.file = file;
        this.data = { pendingLinks: {}, merchants: {} };
    }

    async load() {
        if (existsSync(this.file)) {
            this.data = JSON.parse(await readFile(this.file, 'utf8'));
        }

        return this;
    }

    async flush() {
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(this.file, JSON.stringify(this.data, null, 2));
    }

    merchant(merchantId) {
        return this.data.merchants[merchantId];
    }

    ensureMerchant(merchantId) {
        this.data.merchants[merchantId] ??= { merchantId, linkedAt: new Date().toISOString(), orders: {} };

        return this.data.merchants[merchantId];
    }

    /** O TokenStore que o Comanda10Client usa. */
    get tokenStore() {
        return {
            get: async merchantId => this.merchant(merchantId)?.tokens,
            save: async (merchantId, tokens) => {
                Object.assign(this.ensureMerchant(merchantId), { tokens, status: 'conectado' });
                await this.flush();
            },
            markDisconnected: async (merchantId, reason) => {
                const merchant = this.merchant(merchantId);

                if (!merchant) return;

                merchant.status = reason;
                merchant.tokens = undefined;
                await this.flush();
            },
        };
    }
}
