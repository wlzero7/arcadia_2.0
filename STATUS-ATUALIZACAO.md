# Atualizacao Arcadia: Duelo, trunfos, All Win e conquistas

Entrega de 7 de outubro de 2026, preparada para publicacao em main apos
validacao e disponibilizacao do ZIP, conforme autorizacao do proprietario.

## Base anterior na branch de trabalho

- Branch: `codex/duel-live-missions-layout`.
- PR aberto: https://github.com/wlzero7/arcadia_2.0/pull/1
- Commit anterior: `d4b5ea9d57d22f00107342986ac6a8ddd52eef54`.
- Duelo ao vivo: Dice, Coin Flip, Crash, Mines, Roleta e Slots.
- Crash e Mines interativos, com estado compartilhado e reconexao.
- Layout de missoes do perfil sem sobreposicao.

## Entrega atualizada

- Catalogo com as 40 conquistas, nomes, descricoes e XP solicitados.
- Regras de resultados, sequencias, moedas, niveis, amizades, missoes,
  inventario, duelos, Coop e progressao das proprias conquistas.
- Conquistas genericas retiradas da exibicao e da contagem. XP antigo
  preservado; registros historicos nao sao apagados.
- Relatos de bugs no perfil: somente a conta `wl07` pode aprovar/rejeitar.
  A conquista e os 10.000 XP so sao concedidos na primeira aprovacao.
- All Win nos jogos Solo existentes, Duelo atual, Racing e salas Coop.
  O servidor usa o saldo real; a Roleta exige uma unica aposta.
- No Coop ha dois controles separados: depositar toda a carteira e
  apostar todo o pote compartilhado. Este ultimo arrisca o pote da sala.
- Os trunfos de Slots antes exclusivos do Duelo tambem funcionam no
  Solo/Coop: ALL WIN aposta tudo; Bloqueador repete um giro perdido.
  No Duelo os efeitos originais permanecem.
- Giros garantidos de Slots exibem os simbolos correspondentes ao premio.
- Resultados do Blackjack MP registrados para conquistas e estatisticas,
  excluindo mesas de treino com apenas um jogador.
- Migracoes de banco aditivas: relatos e inventario persistente de Blackjack.

## Blackjack e trunfos concluidos

- Blackjack no Duelo com cartas, comprar, parar, dobrar e trunfos ao vivo.
- Oito trunfos com inventario compartilhado persistente em Solo, Duelo
  e multiplayer; drops, consumo e validacao de energia no servidor.
- Contra o dealer, Escudo evita uma compra que estouraria e Espelhar
  desvia sua proxima carta extra. No multiplayer preservam defesa/ataque.
- Blackjack MP usa carteira Coop: apostas individuais confirmadas,
  All Win, divisao do pote em empates e reembolso se todos estouram.
  Nao repete apostas automaticamente; reconexoes tem janela de 25 segundos.
- Falhas de gravacao revertem cartas, saldos e estado sem publicar
  resultados nao confirmados. Trocar de mesa nao abandona uma aposta ativa.
- Dez trunfos de Slots testados nos tres modos, com inventario atualizado
  apos consumo/drop e simbolos correspondentes aos giros garantidos.
- Campos de entrada de Blackjack MP e Racing aceitam os seis caracteres
  do codigo das mesas.

## Escopo e publicacao

As regras de conquistas sao neutras por modo. Esta entrega nao cria
combinacoes que nao existiam: Racing permanece na mesa multiplayer,
Plinko no Solo e Mines no Solo/Duelo. Blackjack e Slots possuem os tres
modos, conforme solicitado para seus trunfos. All Win foi integrado a
todos os jogos e modos disponiveis.

O usuario autorizou publicar a entrega completa em main apos o ZIP e
os testes, por commit ou merge do PR. Checkpoints parciais nao vao para main.
O modelo render.yaml usa SQLite em disco temporario no plano gratuito.
Em 7 de outubro de 2026, o usuario confirmou que usa banco descartavel
e autorizou esta publicacao mesmo com possivel reinicializacao das contas
e saldos pelo Render. Para contas permanentes, configure armazenamento
persistente e backups antes de futuras publicacoes.

## Validacao

- 114 testes automaticos passando: HTTP real, catalogo completo, recompensas
  unicas, sequencias, limites, saldos, reconexao, consumo dos trunfos,
  All Win e aprovacao de bugs.
- Navegador: dois jogadores nos sete jogos do Duelo; Blackjack Solo e MP,
  trunfos, All Win, turnos, carta oculta e reconexao; layout de missoes
  em 1280, 390 e 320 pixels; perfil com 40 conquistas e aprovacao de bugs.
- Interfaces All Win de Dice, Coin Flip, Mines, Crash, Plinko, Roleta,
  Slots, Blackjack, Racing e Coop com apostas em banco de teste.
- Sem erros JavaScript observados nessa verificacao de navegador.
- Dependencias instaladas, dados de usuarios, segredos, `.git` e
  arquivos temporarios nao fazem parte do ZIP.

## Executar localmente

Na pasta `server`, instale as dependencias com `npm ci` e execute
`npm test`. Configure `JWT_SECRET` e um `DB_PATH` de desenvolvimento
antes de iniciar com `npm start`. Nao use banco de producao para testes.
