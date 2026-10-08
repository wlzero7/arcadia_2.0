# Banco persistente: configuracao privada

O banco Arcadia foi criado na conta Turso do proprietario. A integracao
foi homologada e ativada no Render Free em 8 de outubro de 2026.

Principal: srv-dauq2jo473hc73c6htgg, release 159ff87, deploy
dep-db3o1grtqb8s73ep5eng Live. Conta, tres carteiras, sessao e imagem
persistiram apos restart real as 08:40 GMT-3. Auto-Deploy On Commit para
main foi reativado. A previa gratuita foi suspensa apos a homologacao.

Em 8/10/2026 o proprietario autorizou configurar uma previa gratuita de
validacao no Render com as credenciais privadas existentes. Esse servico
roda server/scripts/preview-probe.cjs: verifica persistencia e uma sala de
16 jogadores, sem expor cadastro, contas, fotos ou jogos ao publico. Uma
falha impede a ativacao. Durante a homologacao o principal permaneceu
inalterado; so recebeu a atualizacao completa depois da aprovacao.

Teste real no computador passou para carteiras, recompensas, missao,
foto, rollback e reinicio. Homologacao 60fc4b6 no Render Free/Oregon passou:
Roleta com 16 jogadores em 1.903 ms; Blackjack com 8 jogadores iniciou em
1.076 ms e liquidou em ate 2.399 ms. Homologacao final b25a413 repetiu os
testes com o cadastro real da API: 1.761 ms. Roleta 16 jogadores 1.869 ms;
Blackjack 8 jogadores inicio 1.079 ms e liquidacao de ate 2.353 ms.
O proprietario pediu expressamente que o agente configure tambem o Turso
no servico principal ao concluir toda a atualizacao. Configuracao feita
privadamente no Render, preservando JWT_SECRET e NODE_ENV existentes.

## Preparar o teste

1. No painel Turso, abra o banco arcadia e use Create Token com permissao
   de leitura e escrita. Mantenha o token privado.
2. Preencha TURSO_DATABASE_URL e TURSO_AUTH_TOKEN em
   server/.env.turso-test, somente no computador. Se esse arquivo nao
   existir, crie-o usando os nomes das variaveis em server/.env.example.
   Nao envie o token em mensagens, capturas de tela ou GitHub.
3. Avise que o arquivo foi preenchido. A verificacao usa esse arquivo
   sem imprimir credenciais e sem conectar o site publicado.

O arquivo privado e ignorado pelo Git e pelas entregas ZIP. O teste cria
uma conta temporaria sem senha utilizavel, verifica carteira, apostas,
missoes, imagem, rollback e dados recuperados em um processo novo.
Depois da verificacao, apaga somente essa conta temporaria. Se falhar,
ela pode ficar preservada para diagnostico; contas reais nao sao apagadas.

## Ativar somente depois da aprovacao dos testes

No ambiente privado do servico Arcadia no Render, configurar:

- TURSO_DATABASE_URL: URL do banco libSQL fornecida pelo Turso.
- TURSO_AUTH_TOKEN: token privado de leitura e escrita.
- REQUIRE_PERSISTENT_DB: 1.
- NODE_VERSION: 20 (mesma versao homologada).

Essas quatro variaveis ja foram configuradas no principal. Nao e preciso
reenvia-las no chat. O banco comecou vazio por autorizacao do proprietario.

Com a protecao habilitada, o servidor nao usara um banco local vazio
quando a configuracao remota estiver faltando ou indisponivel.

O token deve permanecer no servidor; nunca no JavaScript do navegador.
Copias de seguranca podem ser exportadas pelo painel Turso, que continua
sob controle do proprietario. Monitorar limites e expiracao do token.

## Criterio de liberacao

O teste de conexao isolado nao basta: validar tambem partidas simultaneas,
rodadas multiplayer, reconexao, desempenho entre as regioes do Render e
Turso e persistencia apos restart/deploy. As transacoes interativas libSQL
tem timeout de 5 segundos. Nao publicar a atualizacao enquanto esses
criterios estiverem pendentes.

Referencia: https://docs.turso.tech/sdk/ts/reference
