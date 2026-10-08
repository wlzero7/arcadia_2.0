# Atualizacao: Futebol e Comunidade

Inicio: 8 de outubro de 2026. Branch feature/football-community.
Base limpa: 89bf901, igual a origin/main. Publicacao em main autorizada
novamente pelo dono em 8/10 apos verificacoes finais; depois retomar AMS.

## Requisitos

- Futebol disponivel em Solo, Duelo e Coop; estadio animado, bola, passes,
  chutes, placar, jogadores com nomes e numeros nas camisas.
- Mais de dez equipes ficticias e pelo menos cem nomes genericos.
- Odds calculadas no servidor com base na forca do elenco; adversarios
  fracos mantem chances reais. Maior forca reduz o multiplicador.
- Duelo tem onze jogadores, sem reservas, com investimento AC por jogador.
  Melhorias permanentes, cobradas apenas pelo incremento e sem reembolso.
- Comunidade com discussoes e feedbacks. Feedback exige conta e nivel >=5,
  incluindo leitura, validado pelo servidor (nao apenas na interface).
- Preservar carteiras separadas, All Win, extratos, missoes, conquistas,
  atomicidade, persistencia Turso e comportamento dos jogos existentes.

## Entrega e seguranca

Desenvolver e testar em branch. ZIP antes de commit. Publicar main somente
quando TODOS os requisitos estiverem concluidos e validados, conforme AGENTS.
Nao usar banco publicado para testes ou criar/eliminar dados reais sem
necessidade/autorizacao. Fixtures e QA devem usar banco local isolado.
Revisar a migracao e a compatibilidade Turso antes do deploy.

## Recursos e retomada

Recursos conferidos antes dos edits: 12% da janela normal restante e
407,43 creditos extras disponiveis, uso dos extras autorizado pelo dono.
Antes de aproximar do esgotamento: ZIP atualizado e pendencias claras.

## Estado

- Comunidade implementada: discussoes publicas; conta para escrever; feedback
  exige conta e nivel >=5 em leitura/escrita. Curtidas idempotentes, respostas,
  pesquisa, paginacao, limites de postagem e moderacao com justificativa/auditoria.
- Futebol implementado nos tres modos com 14 equipes e 154 jogadores.
  A pedido do dono, nomes internacionais e NENHUM sobrenome repetido; camisas
  usam sobrenome e numero. Identificadores, posicoes e atributos preservados.
- Estadio compartilhado Three.js, campo, arquibancadas, 22 jogadores, bola,
  passes, chutes, gols, placar e camera interativa. Dependencia local 0.186.1,
  sem CDN. Recursos descartados ao sair/trocar de cena.
- Odds/RNG no servidor; eventos futuros e resultado final nunca enviados
  durante a partida. Solo tem aposta reservada e liquidacao persistida unica.
  Coop reserva o pote e redistribui participacoes. Duelo conserva as
  transferencias entre carteiras e congela os dois elencos.
- Editor de onze titulares por posicao, investimento incremental por jogador,
  revisao otimista e saldo Duelo. Implementacao atual: melhorias permanentes.
  Mantida a escolha implementada de melhorias permanentes.
- Migracao aditiva: football_clubs, football_results, community_threads,
  community_replies, community_likes e community_moderation. Nenhuma tabela
  existente removida e nenhum banco de producao acessado nesta etapa.
- Branch de desenvolvimento feature/football-community; integracao final
  em main autorizada pelo ultimo pedido. Nao criar recursos de nuvem adicionais.

## Testes executados

- Suite local final: 166 testes, incluindo carga de 16 partidas ativas.
- O teste de integracao libSQL executa mais 22 casos contra o adaptador
  oficial de producao e arquivos isolados. Nao e uma homologacao remota Turso.
- HTTP real: autenticacao, nivel 4/5, permissoes de moderacao, consultas sem
  campos privados, pagamento e segredo da partida, isolamento entre usuarios.
- Playwright passou antes da troca de nomes: dois jogadores em Duelo/Coop,
  Solo, editor, recarga/reconexao, liquidacao, comunidade, XSS e telas
  1280/390/320. Canvas nao vazio e em movimento nos tres modos.
- Repeticao visual com os nomes novos passou nos tres modos e tres tamanhos,
  sem erros de JavaScript. O catalogo real da previa confirmou 154 sobrenomes
  distintos. Capturas e capa do jogo atualizadas com o novo catalogo.
- Revisao final: Solo e Coop restauram confronto, odds, escolha e valor da
  aposta do servidor ao recarregar, inclusive quando nao sao os times padrao.
- Fallback sem WebGL passou em 390 px, com mercado e placar ao vivo operantes.
- Carga de 16 partidas isoladas, liquidacao idempotente e conservacao de saldo
  passaram no driver local e no adaptador libSQL (22 casos, 4,8 s totais).
- npm audit --omit=dev: zero vulnerabilidades. diff --check passou.
- Capturas e roteiro local: work/visual-output/football-community e
  work/football-ui-check.cjs (fora do repositorio e sem dados de producao).

## Entrega final

- ZIP final antes do commit: work/deliverables/arcadia-futebol-comunidade-final.zip.
- Homologacao da nova funcionalidade feita localmente, conforme escolha do
  proprietario. Nao afirmar que este teste mede latencia remota Turso.
- Driver e persistencia de producao ja homologados na atualizacao anterior;
  esta migracao e aditiva. Conferir paginas, catalogo e saude apos o deploy.
- Nenhum fixture criado no banco real nem recursos adicionais de nuvem.

## Checkpoint local atualizado

- ZIP parcial: work/deliverables/arcadia-futebol-comunidade-nomes-atualizados.zip.
- Previa local: http://localhost:49509/football.html, processo 25388.
  Banco de desenvolvimento separado, nao e o site publicado.
- Recursos conferidos: 308,26 creditos extras disponiveis em 8/10.
- Validacao local concluida nesta etapa; homologacao remota permanece pendente.
- Ultimo pedido atendido: nomes internacionais e nenhum sobrenome repetido.

## Validacao planejada

Testes de RNG/odds, conservacao de saldos, investimento, replay/idempotencia,
liquidacao/reconexao Solo/Duelo/Coop, autorizacao nivel 5, XSS, moderacao,
limites de postagem e persistencia. Regressao completa dos jogos existentes.
QA visual e interacoes em desktop, 390 e 320 px; cena nao vazia e em movimento.
