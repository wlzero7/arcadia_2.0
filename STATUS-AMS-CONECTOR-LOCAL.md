# Conector AMS - checkpoint local, 8 de outubro de 2026

Branch: feature/ams-account-bridge, base 3d69ce3 (futebol/comunidade publicados).
O proprietario autorizou preparar e testar LOCALMENTE a integracao de contas.
Nao publicar este conector na main, Render ou modificar jogadores reais.

Implementado: POST /api/ams/commands desativado sem AMS_COMMAND_PUBLIC_KEY,
assinatura Ed25519, envelope de 30 segundos, prova MFA de cinco minutos,
validacao Zod estrita, comandos delimitados e ator assinado pelo servidor AMS.
Worker apenas consulta; Owner/Dev alteram nome, suspensao e sessoes, ou ajustam
saldo AC. Dev limitado a um milhao AC por comando; XP somente Owner atraves
das regras atuais. Nenhum console SQL, chave privada ou resultado manipulado.

Partidas/stakes ativos bloqueiam alteracoes. Saldos/revisoes usam valores
esperados. Comando, alteracao e recibo sao atomicos; ajuste AC gera ledger.
UUID repetido com o mesmo conteudo retorna o recibo sem creditar/revogar de
novo. Conteudo diferente conflita. Suspensao bloqueia login, HTTP e sockets;
revogacao invalida token_version e desconecta apenas apos o primeiro commit.

Verificacoes: suite completa e testes de assinatura/adulteracao/MFA/cargos,
repeticao, saldo obsoleto/insuficiente, rollback da auditoria, partidas ativas,
suspensao, XP e repeticao de revogacao. Integracao AMS->jogo em HTTP real:
15 verificacoes, bancos SQLite descartaveis, sem conexao remota.
Nao representa teste de carga/latencia do conector hospedado no Turso/Render.

Companion AMS: ../arcadia-management-system, feature/foundation-rbac, draft
PR #1. STATUS.md e docs/OPERATIONS-0.2.md detalham o contrato e limites.
ZIP: ../deliverables/arcadia-ams-conector-local.zip, sem credenciais ou dados.
Nenhum par de chaves real foi configurado. Antes de ativar: nova autorizacao,
chaves privadas separadas, rotacao de credenciais expostas, MFA Owner, teste
isolado hospedado, backup/restore e desempenho. Nao reusar token RW no AMS.
