# DocSynth API

API NestJS e worker Python para receber PDFs PUR/RDA, extrair Markdown e gerar sínteses em tempo real com um servidor de modelos compatível com OpenAI, como o llama.cpp.

## O que o projeto oferece

- Cadastro e autenticação com token; documentos isolados por usuário.
- Upload de PDF de até 20 MB, extração OCR em segundo plano e download do PDF ou Markdown.
- Geração de sínteses por tópicos com resposta incremental via Server-Sent Events (SSE), progresso do processamento do prompt e cancelamento.
- Prévia da síntese antes de salvá-la no histórico.

## Arquitetura

| Componente | Responsabilidade |
| --- | --- |
| API NestJS | Autenticação, validação, endpoints de documentos e conexão SSE. |
| PostgreSQL + Prisma | Usuários, metadados e estados dos documentos, sínteses salvas. |
| MinIO | Arquivos PDF e Markdown extraído. |
| Redis | Filas de trabalho, Pub/Sub dos eventos, progresso e prévias temporárias. |
| Worker Python | OCR com `OCR-Extraction` e síntese em streaming via `/v1/chat/completions`. |

O frontend envia o PDF à API, que o registra e enfileira o OCR. O worker processa o documento e publica atualizações no Redis; a API as entrega ao navegador por `GET /documents/:id/events`. Na geração da síntese, o worker encaminha os fragmentos recebidos do modelo sem esperar a resposta completa.

> [!IMPORTANT]
> A prévia gerada e o texto parcial de uma geração cancelada ficam no Redis por até 30 dias. Eles só passam a integrar o histórico no PostgreSQL quando uma síntese **concluída** é salva com `POST /documents/:id/summaries`. Uma perda dos dados do Redis pode eliminar prévias ainda não salvas.

## Pré-requisitos

- Node.js 20.19+ (20.x), 22.12+ (22.x) ou 24+, com pnpm.
- Python 3.12 ou superior e [uv](https://docs.astral.sh/uv/).
- Docker com Docker Compose para PostgreSQL, MinIO e Redis.
- Um servidor acessível pela URL `OCR_BASE_URL` com API `/v1`, capaz de atender os modelos definidos em `OCR_MODEL` e `SUMMARY_MODEL`.
- O pacote local `OCR-Extraction`, exigido por `ocr_worker/pyproject.toml`.

> [!NOTE]
> O worker usa `../../../OCR-Extraction` a partir de `ocr_worker/`. Organize os checkouts de forma que esse caminho exista ou ajuste a fonte local em `ocr_worker/pyproject.toml` antes de executar `uv sync`.

## Início rápido

Execute os comandos na raiz deste repositório:

```bash
cp .env.example .env
pnpm install
pnpm db:up
pnpm db:migrate
pnpm start:dev
```

Antes de iniciar, edite `.env`: substitua `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`, `S3_SECRET_KEY` e `JWT_SECRET`; mantenha `DATABASE_URL` e as credenciais `S3_*` alinhadas aos serviços do Compose. Configure `OCR_BASE_URL`, `OCR_MODEL` e `SUMMARY_MODEL` para o servidor de inferência disponível. Se houver frontend em outra origem, ajuste `FRONTEND_ORIGIN`.

Em outro terminal, inicie o worker:

```bash
UV_CACHE_DIR=ocr_worker/.uv-cache uv sync --project ocr_worker
pnpm ocr:worker
```

A API fica em `http://localhost:3000` e a documentação interativa em **http://localhost:3000/docs**. Por padrão, o Compose expõe PostgreSQL (`5432`), MinIO (`9000` e console `9001`) e Redis (`6379`) apenas em `127.0.0.1`. As portas podem ser alteradas no `.env`.

> [!TIP]
> O worker solicita `return_progress=true` ao llama.cpp para exibir a porcentagem de processamento do prompt. Use uma versão do servidor que aceite esse parâmetro em `/v1/chat/completions`. Para o modelo Ternary Bonsai, a síntese também envia `enable_thinking=false`.

## Fluxo da API

Os endpoints de documentos exigem `Authorization: Bearer <token>`. Consulte `/docs` para os corpos e respostas completos.

| Método | Rota | Uso |
| --- | --- | --- |
| `POST` | `/auth/register`, `/auth/login` | Criar conta ou obter token. |
| `GET` / `POST` | `/auth/me`, `/auth/logout` | Consultar ou encerrar a sessão. |
| `POST` | `/documents` | Enviar PDF multipart (`file`, `type`: `PUR` ou `RDA`). |
| `GET` | `/documents`, `/documents/:id` | Listar metadados dos documentos (`?type=PUR&limit=25&cursor=<id>`) ou consultar um documento com a prévia da síntese. A listagem retorna `items`, `nextCursor` e `total`; `limit` aceita de 1 a 50. |
| `GET` | `/documents/:id/summaries` | Listar o histórico de sínteses do documento com `limit` e `cursor`. |
| `GET` | `/documents/:id/download`, `/documents/:id/markdown` | Baixar os arquivos. |
| `POST` | `/documents/:id/generate` | Iniciar a síntese com `topics` obrigatório e `questions` opcional. |
| `GET` | `/documents/:id/events` | Receber progresso e deltas via SSE. |
| `POST` | `/documents/:id/cancel` | Solicitar o cancelamento da geração. |
| `POST` | `/documents/:id/summaries` | Salvar uma síntese concluída no histórico. |

Após iniciar a geração, mantenha a conexão SSE aberta para receber eventos `status`, `prompt_progress`, `reasoning`, `summary_delta` e `error`, quando ocorrerem. O cancelamento passa por `CANCELLING` até o worker confirmar `CANCELLED`; a prévia parcial permanece disponível, mas não pode ser salva como síntese concluída.

## Configuração e comandos úteis

O [`.env.example`](./.env.example) documenta todas as variáveis. As principais são:

| Variáveis | Finalidade |
| --- | --- |
| `DATABASE_URL`, `POSTGRES_*` | Conexão Prisma e container PostgreSQL. |
| `S3_*`, `MINIO_*` | Armazenamento de arquivos e portas do MinIO. |
| `REDIS_URL`, `REDIS_PORT` | Fila, eventos e cache temporário. |
| `OCR_BASE_URL`, `OCR_API_KEY`, `OCR_MODEL`, `SUMMARY_MODEL` | Servidor de inferência e modelos. |
| `JWT_SECRET`, `FRONTEND_ORIGIN`, `PORT` | Autenticação, CORS e porta HTTP. |
| `LOG_LEVEL`, `OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET` | Logs do worker e telemetria opcional. |

```bash
pnpm lint        # Oxlint
pnpm build       # gera o cliente Prisma e compila a API
pnpm db:deploy   # aplica migrations existentes fora do desenvolvimento
pnpm db:down     # para os containers sem apagar os volumes
```

> [!WARNING]
> Esta configuração usa uma instância da API e uma do worker. O processamento das filas usa listas Redis simples; revise a estratégia de consumo antes de escalar horizontalmente. Não publique o `.env`, credenciais ou PDFs no Git.
