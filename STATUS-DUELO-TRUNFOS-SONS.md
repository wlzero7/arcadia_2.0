# Duelo, trunfos e sons - entrega de 8 de outubro de 2026

Implementacao e QA concluidos, incluindo o pedido adicional de arena escura
do X1 no Coop, Blackjack Coop e Corrida Coop. ZIP atualizado antes do commit.
Publicacao final em main autorizada; verificacao do deploy registrada na entrega.
Branch de desenvolvimento: feature/duel-capital-auction-trumps, base 5b57380.
O relatorio entregue ao lado do ZIP registra o commit e a verificacao do deploy.

## Implementacao

- Ambos prontos abrem automaticamente um leilao de 25 segundos. Prazo no
  servidor, maior lance valido, desempate por ordem e inicio independente dos
  clientes. Sem lances: jogo aleatorio, sem taxa. So o lance vencedor e cobrado.
- Cada jogador escolhe capital de entrada a partir de 20 AC. Perdas, lances,
  dobro, premios e All Win usam somente o capital da batalha. O resto da
  carteira e protegido; recompensas novas nao ampliam o risco. O capital
  permanece na carteira, sem segundo debito/devolucao. Treinamento de elenco
  fica bloqueado enquanto os fundos estiverem alocados a um Duelo.
- All Win exibe o capital restante, sem substituir o saldo real da carteira.
- Duelo Blackjack tem duas maos HUMANAS e turnos, sem dealer automatico.
  As maos ficam abertas como na mesa multiplayer; baralho futuro nunca e
  enviado ao cliente. Ambos cobrem aposta/dobro e recebem registro de resultado.
- Sete trunfos novos descartaveis em Solo, Duelo e Blackjack Coop: Renovar,
  Jogada Perfeita, Amoroso, Dobrar adversario, Recuperacao, Lucro 2x e Mais um.
  Recuperacao reembaralha a mesma rodada, mantendo apostas e saldos, sem XP.
  Cartas perfeitas calculam SEMPRE 21; podem estourar sob limite 17.
  Lucro 2x no Duelo e limitado pelo capital do adversario; no Coop seu bonus
  ficticio fica explicito no resultado e no historico, alem do pote distribuido.
- Cada comprar/parar/dobrar ACEITO sorteia exatamente uma chance de 50%.
  Inicio, trunfos, recusas e repeticao da liquidacao nao sorteiam cartas.
- Avatares/nomes e apresentacao Partida iniciada em Duelo e Coop. Duelo
  mostra os capitais de entrada; a apresentacao nao aparece no Solo.
- Arena escura compartilhada entre X1 e as salas Coop, incluindo Blackjack
  e Corrida. Participantes acima do jogo, nomes/avatares e valores destacados.
  Campos de valor e botoes cabem em 320 px; Roleta adapta a grade de numeros.
- Sons de todas as familias existentes, compras multiplayer sem repeticao,
  chutes/passes/gols/rede/apitos no futebol. Mute silencia inclusive sons
  ja agendados; nos de audio sao liberados ao terminar. Respeita aba oculta.
- Duelo antigo pronto/leilao/partida migra sem cobranca duplicada. Timers e
  capital sobrevivem a hidratacao. Estado novo e removido corretamente no
  rollback; criar/entrar com falha nao deixa participantes ou salas fantasmas.
- Carteiras e resultados PVP usam lotes atomicos. Falha de envio da tela
  depois do commit nao restaura uma rodada ja liquidada nem repete premios.
- Health inclui somente o SHA publico do deploy, validado e sem cache;
  nenhuma credencial e exibida.

## Verificacao

- 224 testes automatizados passaram; zero falhas. Incluem 48 verificacoes
  dedicadas repetidas com o adaptador libSQL oficial em banco local isolado.
- Testes de rollback, empate, ambos estourados, segundo jogador, caps,
  all-win por jogador, recovery offline, trunfos consumiveis e chance de 50%.
- Liquidacao PVP agrega os dois registros e dois movimentos; teste limita
  requisicoes remotas simuladas a 25 e liquidacao local a 2500 ms. Isso nao
  representa medicao de carga/latencia do Render ou Turso em producao.
- 110 verificacoes Playwright passaram, sem erros de pagina, em 1280/390/320 px.
  Incluem leilao REAL de 25s, controles humanos, catalogos, avatares, All Win,
  dezesseis efeitos de audio, mute e compras sem repeticao ao sincronizar.
- Cinco jogos Coop ao vivo foram repetidos com dois clientes e telas pequenas,
  junto de upload de avatar, ranking e missoes sem sobreposicao. Corrida Coop
  valida avatares, apresentacao, reconexao e liquidacao normal com a nova arena.
- Futebol/Comunidade passaram novamente: Solo/Duelo/Coop, dois clientes,
  reconexao, resultado unico, estadio 3D nao vazio e em movimento, verificacao
  de pixels e layouts desktop/mobile. Capturas revisadas visualmente.
- npm audit --omit=dev: zero vulnerabilidades conhecidas; diff --check passou.
- Testes usam dados descartaveis locais. Nenhuma conta fixture foi criada
  no Turso ou Render, e nenhuma aposta de jogador real foi executada.

## Entrega e continuidade

- ZIP final: ../deliverables/arcadia-duelo-trunfos-sons-final.zip.
- Codigo do jogo pode ser publicado conforme autorizacao permanente.
  Conferir main remoto e deploy; nao confundir HTTP 200 com release correto.
- AMS main anterior d70edf4 e uma PREVIA LOCAL, nao um servico publicado.
  Chaves privadas, rotacao de credenciais, MFA pessoal do Owner, hospedagem
  HTTPS e validacoes de producao permanecem separados desta entrega do jogo.
- Segredos, bancos privados, dependencias e temporarios nao entram no ZIP.
- Conferir recursos antes de retomar e preservar ZIP antes de esgotar limites.
