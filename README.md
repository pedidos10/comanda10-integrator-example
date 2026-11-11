# Integradora Exemplo · Comanda10 Integrator API

Código de exemplo oficial de uma integradora consumindo a Comanda10 Integrator API. Ele faz o vínculo com
estabelecimentos, mostra o cardápio, sincroniza pedidos e consulta indicadores, com uma tela simples para
acompanhar cada chamada.

Use como referência ou copie as partes que servirem. Não tem dependências: só Node.js 22 ou mais novo.

## Rodar

1. Copie `.env.example` para `.env` e preencha com as credenciais **Sandbox** recebidas do suporte do
   Comanda10.
2. Rode `npm start` e abra `http://localhost:4400`.
3. Clique em **Gerar código de vínculo** e aprove no gestão Sandbox com o login do estabelecimento de teste.
4. Cole o código de autorização que o gestão mostrar e clique em **Concluir**.

Para testar: `npm test`.

## O que olhar

| Arquivo | O que mostra |
|---------|--------------|
| [`src/comanda10Client.js`](src/comanda10Client.js) | O cliente da API, a parte para levar para o seu sistema. Faz o vínculo OAuth, guarda os tokens por estabelecimento, renova antes de expirar e depois de um `401`, espera o `Retry-After` num `429` e marca o estabelecimento como desconectado num `403`. |
| [`src/orderSync.js`](src/orderSync.js) | A sincronização incremental de pedidos com `updatedSince` e `nextCursor`. |
| [`src/store.js`](src/store.js) | Onde ficam tokens e pedidos. Aqui é um arquivo JSON; no seu sistema, um banco de dados. |
| [`src/server.js`](src/server.js) | O backend da tela. O `clientSecret` e os tokens nunca vão para o navegador. |
| [`test/`](test) | Testes do cliente e da sincronização, com a API simulada. |

## Regras que o exemplo segue

- Credenciais e endereço da API ficam em variáveis de ambiente. Para ir para a produção, troque as Sandbox
  pelas Production.
- Os tokens são guardados por `merchantId`. Cada renovação devolve um `refreshToken` novo e invalida o
  anterior, então renovações simultâneas do mesmo estabelecimento viram uma chamada só.
- Um `403`, ou uma renovação recusada, encerra o vínculo. A tela mostra o motivo, e só um vínculo novo
  devolve o acesso.
- Na sincronização, o instante guardado é o do início da rodada menos 5 minutos, e cada pedido é gravado
  pelo `id`. Pedidos repetidos entre rodadas são esperados.

A documentação completa da API fica em `/docs` no endereço da API. Para assistentes de IA, use
`/llms-full.txt`.

## Licença

MIT
