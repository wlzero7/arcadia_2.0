# 🎰 Arcadia

**Arcadia — Social Casino Simulator** (v1.2.0 — correções de jogos, persistência e segurança)

Cassino social **100% free**: sem compras, sem microtransações, sem dinheiro real.
ArcCoins (AC) são fictícios — a graça é apostar **com os amigos**, do **pote compartilhado**.

## O que roda

- **Backend** (`server/`): Node + Express + **Socket.IO** + **SQLite** (node-sqlite3-wasm, arquivo em disco — sem instalar Postgres)
  - Auth JWT (bcrypt), carteira transacional com extrato
  - Jogos solo server-side: 🎲 Dados (6x), 🪙 Coinflip (2x), 💣 **Mines** (start/pick/cashout), 🚀 **Crash** (animado), 🃏 **Blackjack** (hit/stand/double, 3:2), 🎡 **Roleta europeia** (pleno/cores/paridade/dúzias)
  - Bônus diário com streak + transferência entre jogadores
  - **Salas multiplayer** em tempo real: pote compartilhado, stakes, saque, chat, histórico — Dados / Coinflip / Crash do Grupo
  - 🏆 **Ranking** global (top 20 por lucro)
- **Frontend** (`js/`, `css/`, `*.html`): páginas existentes + nova `rooms.html` (salas multiplayer)

## Rodando

```bash
cd server
npm ci
npm test
npm run dev        # API + Socket.IO + frontend em http://localhost:3000
```

**A partir da v0.6 o próprio Express serve o frontend** — um serviço só.
Abra http://localhost:3000. A variável `PORT` permite escolher outra porta.
No Render, configure Root Directory como `arcadia`, Build Command como
`cd server && npm ci` e Start Command como `cd server && npm start`.

## Persistência no Render

O SQLite deve ficar em armazenamento persistente. O plano gratuito do Render
usa disco efêmero: publicar uma atualização pode apagar contas, saldos e partidas.
Antes do deploy, faça backup do banco atual, configure um disco persistente no
serviço e defina `DB_PATH=/var/data/arcadia.db`. Copie o banco existente para esse
caminho com o servidor parado. A configuração do disco pode exigir um plano pago;
o arquivo `render.yaml` mantém o plano atual para não alterar custos automaticamente.

Partidas solo, corridas, duelos, potes, participações e apostas pendentes são
persistidos no mesmo banco. Isso protege reinícios somente quando o arquivo do banco
é preservado. Não execute várias instâncias do servidor usando este SQLite.

Em produção, `JWT_SECRET` é obrigatório. A sessão usa cookie HttpOnly; tokens
legados são migrados no próximo acesso. Trocar a senha revoga as sessões antigas.
Frontend, API e Socket.IO usam a mesma origem. `ALLOWED_ORIGINS` permite uma lista
explícita de outras origens quando necessário.

## Regras do pote compartilhado

1. Cada jogador **deposita** AC do próprio saldo no pote da sala.
2. Qualquer um **aposta do pote** — ganhou, o prêmio volta pro pote; perdeu, o pote paga.
3. Lucros e perdas são distribuídos proporcionalmente entre as participações no pote.
4. Cada jogador saca sua participação atual pela carteira Coop. Participações ficam
   preservadas quando o jogador desconecta. Finalize apostas pendentes da roleta antes
   de depositar ou sacar.
5. Host sai? Um jogador conectado assume. Salas com créditos permanecem recuperáveis.

## Coin Flip e missões

`coinflip.html` permite jogar Solo, com escolhas Cara/Coroa de probabilidade
igual e prêmio total 2x a aposta quando houver acerto. Nas salas Coop, o resultado
afeta o pote e as participações proporcionais. No Duelo, Coin Flip é uma opção do
leilão; a rodada transfere créditos entre os jogadores, sem criar créditos novos.
Os links Duelo e Coop da tela Solo selecionam Coin Flip nos respectivos controles.

`missoes.html` reúne 21 missões diárias e 7 semanais, com filtros, progresso,
nível e resgate de XP. O perfil exibe um resumo e acesso à página completa.
Login conta uma vez por dia, jogos diferentes são deduplicados e partidas de
Coin Flip nos três modos contam para os objetivos do jogo. Blackjack MP conta
somente com dois ou mais participantes na rodada; espectadores offline não
recebem progresso. Cancelar Mines sem escolhas devolve a aposta sem conceder XP,
conquistas ou progresso de missões.

Os períodos usam UTC: diárias renovam à meia-noite UTC; semanais aos domingos
à meia-noite UTC, com novo período também na virada do ano. A página mostra a
data no horário local do navegador. Resgates e XP são transacionais e únicos;
uma tela com período expirado deve ser atualizada antes de resgatar.

## Verificação

`npm test` executa regressões de créditos, trunfos, partidas, reconexão e testes reais
de HTTP e WebSocket em banco temporário. GitHub Actions roda a suíte em Node 20 e 24.
Em um ambiente sem dependências, `ARCADIA_OFFLINE_TEST=1` permite executar as
regressões com SQLite nativo do Node 24; nesse modo o teste HTTP fica explicitamente
ignorado, sem validar Express, JWT ou Socket.IO reais.

No duelo, o jogo do leilão fica bloqueado e os créditos de cada rodada são
transferidos entre os oponentes. O lance vencedor continua sendo uma taxa do leilão.
Resultados acima do saldo do adversário são limitados ao saldo disponível.
Sair antes da partida cancela o duelo. Sair durante a partida registra derrota,
sem confiscar o saldo restante nem devolver a taxa do leilão.

## ArcCoins

AC não tem valor monetário, não é comprado, não é sacado, não é criptomoeda.

## Status

- v0.1 — Foundation (auth + wallet local)
- v0.2 — API + JWT
- v0.3 — **Multiplayer: salas com pote compartilhado (Socket.IO + SQLite)**
- v0.4 — **Mines interativo + Crash animado + Ranking global**
- v0.5 — **Amigos (pedidos/aceitar/remover) + Perfil com extrato e transferência**
- v0.6 — **Deploy-ready: Express serve o frontend estático + Dockerfile + .env.example**
- v0.7 — **Salas multiplayer persistidas no SQLite** (sobrevivem a restart)
- v0.8 — **Blackjack completo (hit/stand/double, 3:2) + Roleta europeia (pleno 36x, cores, dúzias)**
- v0.9.4-fix — **🐛 Correções: botões de jogos mortos no hub (getBalance inexistente quebrava games.js), cache de 24h em JS servindo versão bugada (agora no-cache/ETag), slogan antigo no hero, link Sobre duplicado, Início com href="#"**
- v0.9.4 — **🎯 Plinko (16 fileiras, 3 riscos, até 1000x) · 🔨 Leilão no X1: 5 modos sorteados, melhor lance (da carteira Duelo) escolhe o modo · ⚡ API otimizada (gzip, cache de assets, rate limit, keepAlive para proxies)**
- v0.9.1 — **🔊 Motor de sons próprio (WebAudio, zero arquivos): dados rolando, explosões, cartas, fichas, vitórias, foguete, cascos, roleta girando, level-up — com botão de mute global · ✨ Visual polido (scrollbar custom, glow no logo, elevação de botões/cards, animações de entrada, focus states) · 📱 Responsividade completa mobile/PC (nav empilhada, grids em 1 coluna, mesas adaptadas, cartas menores)**
- v0.9 — **🐎 Corrida de Cavalos multiplayer (Barry, Clade, Lucy, Nicolas, Augusto...), ⚔️ Duelo x1 (falência = derrota, carteira própria), 🎴 Blackjack MP com cartas especiais (6 raridades: comum→cromática) + NRG, 🎡 Roleta do grupo (todos apostam no mesmo giro), carteiras separadas solo/coop/duelo, XP e level 1→999, conquistas, missões diárias/semanais, perfil com avatar editável**
