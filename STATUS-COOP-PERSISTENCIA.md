# Checkpoint: Coop, fotos, economia e Turso

Data: 8 de outubro de 2026. Atualizacao PARCIAL, nao publicada em main.
Branch: feature/coop-avatars-persistence.
Base integrada: 7441d82 (origin/main em 8/10).

## Pedido e autorizacoes

- Lobby Coop, jogos ao vivo, animacoes e grafico real do pote.
- Editor de avatar sem corte, arquivo/URL, foto em chat e ranking, favicon.
- Banco Turso arcadia na conta do proprietario; autorizado iniciar vazio.
- Progressao mais dificil, moedas de missoes e conquistas nas tres carteiras.
- Autorizado configurar Turso no Render e criar previa gratuita isolada.
- Credenciais somente no arquivo privado ignorado e nas variaveis do Render.
- Entregar ZIP antes do commit. Main somente depois de concluir e validar.
- Antes de esgotar limites: ZIP atualizado e pendencias, sem anunciar conclusao.

## Implementado

- Coop com layout responsivo e cinco jogos visuais: Dice, Coin Flip, Slots,
  Roleta e Crash. Blackjack MP e Racing mantem suas salas dedicadas.
- Crash com relogio do servidor, saque manual/automatico, segredo oculto,
  escrow persistido, reconexao, bloqueio de movimentos e liquidacao unica.
- Grafico de resultados reais do pote, avatares em participantes e chat.
- Dialogo de avatar: icones, PNG/JPEG/WebP local ou HTTPS publico.
  Limites: 5 MB, 64 a 4096 px, imagem final WebP 256x256 no banco.
- Importacao HTTPS com DNS validado e fixado, redirecionamentos revalidados,
  bloqueio de redes privadas e prazos para DNS/download/interrupcoes.
- Foto no ranking, perfil publico, chat Coop e Blackjack MP.
- Logo fornecida como favicon em todas as 19 paginas.
- Driver oficial libSQL/synckit, transacoes atomicas, consultas agrupadas,
  circuit breaker e sem fallback silencioso para SQLite descartavel.
- Integrados os commits recentes do proprietario sobre recompensas:
  100.000 AC por conquista para CADA carteira; missao concede por carteira
  maximo entre 10.000 AC e XP * 100. Catalogo das 40 conquistas preservado.
- Recompensa somente uma vez; propriedade/resgate, XP, moedas e registros
  da carteira confirmados ou revertidos juntos.
- Nova curva: proximo nivel exige floor(300 * nivel^1.65) XP.
  Partida concede 10 + min(40, floor(sqrt(aposta) / 10)), no maximo 50 XP.
  Niveis existentes e XP das conquistas nao foram reduzidos.
- Perfil/missoes usam o limite de XP calculado no servidor e mostram AC.
- Respostas de partidas incluem o saldo final com moedas de conquistas.
- render.yaml exige persistencia e configuracao privada antes de iniciar.

## Validacao de 8/10

- Suite completa: 135/135 passaram, nenhuma falha ou skip.
- Novos testes de recompensas nas tres carteiras, pagamentos unicos,
  saldo exato do extrato, falha com rollback, curva e limite de XP.
- Testes de transacoes/batches e downloads incluindo interrupcao e DNS.
- Playwright passou: dois jogadores, cinco jogos, desktop/390/320 px,
  resultados iguais, grafico nao vazio, upload/reload/ranking/dialogo,
  favicon, sem erros de JavaScript.
- Conexao real ao Turso passou: conta, aposta, recompensas nas tres
  carteiras, missao sem duplicar, foto BLOB, rollback e processo novo.
  Tempos locais: criar conta 99 ms; primeira aposta 399 ms; segunda 440 ms;
  resgatar missao 168 ms; foto 65 ms. Contas temporarias removidas.
- Sala de 16 jogadores conservou pote e registrou todas as apostas, mas
  liquidou em 4.067 ms. Acima da margem de 3 s: bloqueia publicacao.
- diff --check com reconhecimento de CRLF passou. Auditoria anterior
  das dependencias de producao nao apontou vulnerabilidades.

## Pendencias obrigatorias

- Medir no Render Oregon contra Turso Sao Paulo, usando previa Free.
  server/scripts/preview-probe.cjs executa os dois testes reais e so inicia
  uma rota de saude se ambos passarem. Nao expoe o aplicativo inacabado.
- Reduzir requisicoes na liquidacao coletiva de Roleta/Blackjack MP.
  O driver sincrono e as transacoes interativas de 5 s exigem margem real.
  Nao publicar sem passar desempenho, atomicidade e reconexao.
- Revalidar visualmente recompensas/XP em perfil e missoes desktop/celular.
- Conferir sons e acabamento compartilhado com Solo/Duelo, sem declarar
  que todos os jogos foram redesenhados.
- Configurar Turso no servico PRINCIPAL somente na entrega final.
- Servico principal Render: srv-dauq2jo473hc73c6htgg, Free, Oregon.
  Estava revertido a cca014f e Auto-Deploy desativado. Push nao confirma
  deploy; sera necessario publicar manualmente ou reativar ao concluir.
- Reexecutar testes/auditoria/sintaxe, ZIP final antes do commit, conferir
  remoto, publicar main sem force push e verificar deploy e persistencia.

## Retomada

- Nao recomecar nem apagar trabalho. O stash coop-persistence-before-main-
  integration foi conservado apos resolver os conflitos de integracao.
- Agendamento unico das 02h17 removido porque a retomada foi iniciada.
- Auxiliares: work/coop-ui-check.cjs e work/checkpoint.ps1.
- Capturas: work/visual-output/coop-update.
- ZIP nunca inclui .env, tokens, dados privados, node_modules ou .git.
- Previa local anterior: http://localhost:62673/rooms.html, banco local
  separado. Nao afirmar que esse processo continua ativo sem verificar.
- Checkpoint preparado com cerca de 70% do limite da janela utilizado.
