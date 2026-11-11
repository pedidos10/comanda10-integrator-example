const required = name => {
    const value = process.env[name];

    if (!value) {
        throw new Error(`Defina ${name} no arquivo .env (copie de .env.example).`);
    }

    return value;
};

export const config = {
    port: Number(process.env.PORT ?? 4400),
    apiUrl: required('COMANDA10_API_URL'),
    clientId: required('COMANDA10_CLIENT_ID'),
    clientSecret: required('COMANDA10_CLIENT_SECRET'),
    initialSyncDays: Number(process.env.INITIAL_SYNC_DAYS ?? 1),
    dataFile: process.env.DATA_FILE ?? 'data/store.json',
};
