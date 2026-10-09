# Amigos, comunidade e recuperacao - entrega validada - 2026-10-09

Esta secao substitui as pendencias do checkpoint historico abaixo.
Branch feature/friends-community-access, base ae0e48c. Pronta para main,
conforme autorizacao; sucesso do deploy deve ser confirmado separadamente.

## Entrega Atual

- Amigos: avatar, nome, usuario, nivel, busca, favoritos, pedidos, contagem,
  remocao confirmada e atalhos X1/Coop. Sem indicador falso de presenca.
- Estatisticas globais e pessoais: topicos, feedbacks e comentarios,
  excluindo removidos e protegendo feedback para contas de nivel 5.
- Duas imagens por publicacao/resposta, previa/remocao/colagem e ampliacao.
  PNG/JPEG/WebP ate 2 MiB por original; reencodificacao e metadados removidos.
- BLOB persistente no banco, limites de pixels/quota/taxa/conversoes.
  Texto e anexos atomicos, download protegido e exclusao na moderacao.
  Parser 6 MiB somente em publicacoes autenticadas; global continua 64 KiB.
- Esqueci minha senha: Brevo, resposta uniforme, token aleatorio hasheado,
  15 minutos/uso unico, limites persistentes, sessoes e sockets revogados,
  carteiras preservadas e invalidacao de links antigos apos troca de senha.
- Brevo real: remetente verificado, chave privada aprovada pelo Owner,
  teste recebido/confirmado. Configuracao salva no Render com Save only,
  sem deploy antecipado; chaves nao entram em fonte ou ZIP.

## Verificacao Atual

- 233 testes servidor; 30 testes interiores no adaptador libSQL local com
  imagens/recuperacao, persistencia apos reconexao e rollback.
- HTTP real: autenticacao, anexos, WebP, feedback protegido e arquivo invalido.
- Playwright amigos/comunidade/imagens e recuperacao, 1280/390/320 px;
  reset, rejeicao de replay, confirmacao, token fora da URL e saldos intactos.
- Auditoria npm producao: zero vulnerabilidades. Diff CRLF validado.
- QA isolado; nenhuma conta/saldo real alterado.
- ZIP final: ../deliverables/arcadia-amigos-comunidade-recuperacao-final.zip.
- AMS 0.2.1 companheiro em ../arcadia-management-system. Conector real segue
  desativado sem chaves, MFA pessoal e gates de producao.

## Checkpoint Historico - 2026-10-08

Branch: feature/friends-community-access. Base publicada: ae0e48c.
Nao publicar esta atualizacao em main antes de concluir o pedido inteiro.
Trabalho atual sem commit, preservado no ZIP arcadia-social-acesso-checkpoint.zip.

## Implementado e validado nesta etapa

- Amizades com foto, nome de exibicao, usuario, nivel e total da lista.
- Busca, favoritos, convites X1/Coop e remocao confirmada com icones Lucide.
- Pedidos recebidos e enviados; aceitar, recusar e cancelar usam rotas existentes.
- Estados vazios, mensagens na pagina, envio por Enter e controle de duplicacao no formulario.
- Estatisticas globais na Comunidade e pessoais no perfil: topicos, feedbacks, comentarios.
- Conteudo removido nao e contado; estatisticas de feedback respeitam o nivel 5.
- 225 testes do servidor passaram. Playwright passou fluxos reais com dois usuarios
  locais: pedido, aceite, foto/nivel, favorito, busca, remocao, contagens e telas
  1280/390/320 px, sem erros de pagina. Capturas revisadas; diff --check aprovado.
- Nenhum teste alterou usuarios reais nem bancos Turso.

## Pendencias obrigatorias

1. Imagens ao escrever topicos/feedbacks/comentarios: selecao/previa/remocao,
   limite por publicacao, validacao e reencodificacao no servidor, persistencia,
   atomicidade e acesso protegido para feedback. Nao implementado nesta etapa.
   O parser global atual aceita apenas 64kb; nao aumentar indiscriminadamente.
   Testar SVG/HTML, arquivos falsos, bombas de pixels, metadados, limite de taxa,
   rollback, remocao moderada, reconexao e navegador/mobile.
2. Recuperacao de senha no Arcadia e AMS e troca autenticada no AMS. Usuario
   confirmou que nao possui servico de envio de email. Escolher/configurar
   provedor e remetente em arquivo privado, sem segredos no chat ou Git.
   Tokens aleatorios armazenados como hash, expiram e sao de uso unico;
   resposta uniforme, limites, revogacao de sessoes e notificacao posterior.
   AMS precisa de email de recuperacao verificado; nao contornar MFA.
3. AMS: revisar compatibilidade de leitura com o Arcadia publicado ae0e48c,
   executar contrato real somente RO e testes locais do conector desativado.
4. Permissoes extras: Owner concede/revoga apenas lista aprovada, com MFA,
   justificativa, auditoria e revogacao de sessoes. Worker nao recebe comandos
   de mutacao do jogo; nao expor secrets ou permitir escalonamento ao Owner.
5. Recompilar e validar instalador AMS atualizado, IA/menu, equipe e recuperacao.
   O AMS 0.2.0 atual ja tem Groq por cargo e promocao Worker -> Dev; 0.1.0 e antigo.
6. QA final de ambos, ZIPs finais ANTES dos commits, publicacao conforme
   autorizacao e verificacao do deploy. Nao chamar este checkpoint de entrega final.

## Continuidade

- Fonte AMS: ../arcadia-management-system, main publicada d70edf4, 0.2.0.
- Instalador existente: ../deliverables/ams-0.2.0-windows-local-setup.exe.
- AMS e previa LOCAL. O conector publicado do jogo segue desativado (503).
- MFA pessoal, rotacao de secrets, chaves reais, hospedagem/backup e QA de
  producao continuam pendentes. Publicar codigo nao habilita operacoes reais.
- Conferir limites antes de retomar, sem apagar/reiniciar trabalho valido.
- Ultima leitura: 93% do limite de cinco horas usado, zero creditos extras.
