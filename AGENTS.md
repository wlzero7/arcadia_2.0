# Preferencias permanentes do proprietario do Arcadia

Repositorio: https://github.com/wlzero7/arcadia_2.0

Estas instrucoes registram as preferencias solicitadas pelo usuario em
7 de outubro de 2026. Aplicam-se as atualizacoes deste projeto, salvo
orientacao posterior diferente do usuario.

## Entrega e GitHub

- Ao concluir integralmente uma atualizacao oficial solicitada, validar
  todos os requisitos e executar os testes pertinentes. Nao apresentar
  uma entrega parcial como completa nem prometer ausencia absoluta de bugs.
- Depois dessa validacao, o usuario autoriza fazer commit das alteracoes
  da atualizacao e publica-las na branch main do GitHub, para permitir
  a atualizacao do Render. Esta preferencia substitui a regra anterior
  de entregar somente uma branch separada com PR.
- Branches e PRs podem ser usados durante o desenvolvimento, mas a entrega
  final deve incluir a publicacao em main, por commit ou merge do PR.
  O usuario confirmou expressamente essa autorizacao em 7 de outubro
  de 2026; nao e preciso pedir a mesma confirmacao a cada atualizacao.
- Nao publicar checkpoints parciais ou uma atualizacao com requisitos
  pendentes em main. Confirmar os testes, conflitos e estado do remoto
  antes da publicacao; nunca usar force push para substituir historico.
- Gerar e disponibilizar o ZIP atualizado antes do commit, preservando
  codigo, recursos e testes, mas excluindo segredos, bancos com dados
  privados, node_modules, .git e arquivos temporarios.
- Nao incluir no commit alteracoes alheias ao pedido e nao reverter
  trabalho preexistente do usuario.
- Informar na entrega o ZIP, os testes executados e o commit publicado
  em main. Nao afirmar que o Render terminou o deploy sem verificar.

## Limites e checkpoints

- Conferir os limites e recursos disponiveis antes de iniciar alteracoes.
- Acompanhar o consumo durante trabalhos longos. Se houver risco de
  esgotamento antes de concluir, gerar e entregar um ZIP parcial atualizado
  com uma lista clara de pendencias antes de interromper o trabalho.
- Retomar do checkpoint existente; nao apagar ou reiniciar trabalho valido.
- Consultar STATUS-ATUALIZACAO.md para o escopo e a validacao da atualizacao.

## Aprovacao de relatos de bugs

- A conquista Reportador de Bugs e os 10.000 XP so sao concedidos depois
  da aprovacao do desenvolvedor pela conta wl07, nunca pelo simples envio.
- A aprovacao e a recompensa devem ser autorizadas e unicas no servidor.

## Integracao AMS em teste local (8 de outubro de 2026)

- O proprietario autorizou preparar e testar a API de gerenciamento de contas
  em branch separada, somente localmente, sem publicar ou alterar dados reais.
- Essa autorizacao especifica prevalece sobre a preferencia permanente de main
  para o conector AMS. Manter feature/ams-account-bridge sem push ou deploy.
- A entrega oficial de futebol e comunidade ja foi publicada em main no commit
  3d69ce3 e verificada no Render. Nao confundir com o novo conector local.
- Conector desativado sem chave publica Ed25519. Operacoes devem manter MFA,
  justificativa, confirmacao no AMS, idempotencia, atomicidade e auditoria.
